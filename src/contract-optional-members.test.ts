// 中立契约的**可选成员**必须有消费方探测（r72）。
//
// ## 被守的缺陷：死契约成员
//
// `BaseBackend` 的可选成员（`listTools?` / `setTools?` / `onProcessExit?` / `answerQuestion?` …）
// 表达的是 §1.5 的「缺面」：某个内核可以没有这个面，壳探测后走三条出路之一
// （适配器翻译 / 内核插件补面 / 显式降级）。这套机制成立的前提是**壳真的去探测**。
//
// r72 实测查出 `resume?` 是一个**死契约成员**：
//   · 契约注释写着「pi 无此面（现场 fork 由 session-store 编排），**壳经 `backend.resume?` 探测**」；
//   · 全仓搜索 `backend.resume` / `resume?.(` / `resume &&` 等**全部调用形态**，
//     唯一命中是这个成员自己的注释 ⇒ 壳从没探测过；
//   · 壳的锚点重启实际走 `SessionStore.resume(snapshotId)`：用快照的 lineage entries
//     在**中立层**派生新会话（`deriveSession`），对所有内核一律适用，不需要任何内核提供回切面；
//   · 只有 dsh 实现了它（`DSH_METHODS.sessionResume`）⇒ 同时是死代码与**内核间功能不对称**。
// 已删除（契约成员 + dsh 实现 + 协议常量），依据写在 backend.ts 的退役说明里。
//
// > 为什么删而不是"改注释说明它没用"：死契约成员**有害**——与 r46/r47 的死能力轴同理，
// > 读者（以及第五个内核的实现者）会以为必须实现它、以为壳会探测它。
// > 没有消费方的抽象不是抽象，是猜测。
//
// ## 判据
//
// 对 `BaseBackend` 的每个可选成员，要求在**壳侧语料**（application / controllers / bootstrap / web）
// 里存在探测形态：`?.name(` / `.name &&` / `typeof ….name` / `if (….name)` / `.name ?`。
// 语料范围本身要被断言（r71 的教训：漏了圆心层就会产假阳性）。
// 注意：**排除契约文件自身与内核实现目录**——契约里的声明和内核里的实现都不是"探测"。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONTRACT = "packages/shared/src/domain/backend.ts";
/** 壳侧语料：会去探测后端能力的层。⚠ 不含 kernel/（那是实现侧）与契约自身。 */
const SHELL_ROOTS = ["src/server/application", "src/server/controllers", "src/server/bootstrap", "src/web", "packages/react/src"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes("/locales/")) out.push(full);
  }
  return out;
}

/** 契约里 BaseBackend 的可选成员名。 */
function optionalMembers(): string[] {
  const src = readFileSync(join(ROOT, CONTRACT), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const m = /export interface BaseBackend\s*\{/.exec(src);
  expect(m, "找不到 BaseBackend 接口（判据会空转）").toBeTruthy();
  let i = m!.index + m![0].length;
  let depth = 1;
  const buf: string[] = [];
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    if (depth > 0) buf.push(c);
    i += 1;
  }
  const out: string[] = [];
  for (const ln of buf.join("").split("\n")) {
    const st = ln.trim();
    if (!st || st.startsWith("//") || st.startsWith("*")) continue;
    const fm = /^(\w+)\?\s*[:(]/.exec(st);
    if (fm) out.push(fm[1]);
  }
  return out;
}

/** 探测形态：可选成员在壳侧被"先判有没有再用"的写法。 */
function probeRx(name: string): RegExp {
  const e = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    // ⚠ 每种形态都必须带**探测语义**，不能是散文提及：
    //   `?.name(` 可选链调用 / `.name?.` 成员上的可选链 / `.name &&` 短路存在性 /
    //   `typeof ….name` 类型探测 / `if (….name` 条件探测 / `!….name` 取反存在性判断。
    //   首版有一条 `\.name\s*\?`（想抓三元），结果把注释里的「壳经 backend.resume? 探测」
    //   这种**散文**也算成探测——死成员会被判成活的，正是本条守卫要防的假绿。
    `\\?\\.\\s*${e}\\s*\\(|\\.\\s*${e}\\s*\\?\\.|\\.\\s*${e}\\s*&&|typeof\\s+[\\w.]*\\b${e}\\b|\\bif\\s*\\([^)]*\\.\\s*${e}\\b|!\\s*[\\w.?]*\\.\\s*${e}\\b`,
  );
}

describe("中立契约的可选成员：必须有壳侧探测点（否则是死抽象 + 内核间不对称）", () => {
  const members = optionalMembers();
  const shellFiles = SHELL_ROOTS.flatMap((r) => walk(join(ROOT, r))).map((f) => ({ file: relative(ROOT, f), src: readFileSync(f, "utf-8") }));

  it("判据不空转：解析到了可选成员，且语料范围正确（含壳侧、不含内核实现）", () => {
    // r72 实测：删除 resume? 之后剩 4 个可选成员
    expect(members.length, `只解析到 ${members.length} 个可选成员（r72 实测 4）⇒ 接口解析可能坏了`).toBeGreaterThanOrEqual(4);
    expect(members, "已删除的 resume 不得复活（它没有消费方，见文件头说明）").not.toContain("resume");
    for (const n of ["listTools", "setTools", "answerQuestion"]) {
      expect(members, `已知的可选成员 ${n} 没被解析出来 ⇒ 判据漏了`).toContain(n);
    }
    expect(shellFiles.length, `壳侧语料只有 ${shellFiles.length} 个文件（应 ≥100）`).toBeGreaterThan(100);
    // 语料范围自检：不得混进内核实现目录（那里的 `name(` 是实现不是探测，会造成假绿）
    // ⚠ 判据要精确到 `src/server/kernel/`：`src/server/bootstrap/kernel/` 是**组装根的内核注册表**
    //   （装配层，属于壳侧），首版用 `/kernel/` 粗匹配把它也算成"实现侧"，于是自检假红。
    expect(shellFiles.some((f) => f.file.startsWith("src/server/kernel/")), "语料混进了 src/server/kernel（实现侧）⇒ 会把实现当探测，判据失效").toBe(false);
    expect(shellFiles.some((f) => f.file.startsWith("src/server/application/")), "语料漏了 application 层（探测主要发生在这里）").toBe(true);
  });

  it("① 每个可选成员在壳侧都有探测点（无探测 = 死契约成员）", () => {
    const dead: string[] = [];
    for (const name of members) {
      const rx = probeRx(name);
      const hits = shellFiles.filter((f) => rx.test(f.src));
      if (hits.length === 0) dead.push(name);
    }
    expect(dead, [
      `${dead.length} 个可选成员在壳侧没有任何探测点：${dead.join(", ")}`,
      `      后果：它是**死契约成员**——契约声称"可缺面、壳会探测"，而壳从不探测；`,
      `            若只有部分内核实现它，还同时构成**内核间功能不对称**（§1.5 同等地位、同等功能）。`,
      `      修法二选一：① 接上消费方（按 §1.5 的三条出路：适配器翻译 / 内核插件补面 / 显式降级）；`,
      `                 ② 若这个面本来就不需要（壳用别的方式统一编排了），**从契约与全部内核里删掉**，`,
      `                    并在契约里留下退役说明（r72 删 resume? 就是这么做的）。`,
      `      ⚠ 不要靠"改注释说明它没用"了结：死成员会让第五个内核的实现者以为必须实现它。`,
    ].join("\n")).toEqual([]);
  });

  it("② 自检：探测判据认得真实的探测写法，也不会把普通提及当成探测", () => {
    // 正例：setTools 的真实探测形态是 `proc.backend.setTools`（if 条件里）
    expect(probeRx("setTools").test("if (patch.toolConfig !== undefined && proc.backend.setTools) {"),
      "自检失败：真实的 `&& backend.setTools` 探测形态没被认出来 ⇒ ① 会产假阳性").toBe(true);
    expect(probeRx("listTools").test("if (!proc?.backend.listTools) return null;"),
      "自检失败：`!backend.listTools` 的存在性判断没被认出来").toBe(true);
    // 反例：一句普通提及（没有探测语义）不该被当成探测
    expect(probeRx("resume").test("// 壳经 backend.resume? 探测（这句是注释里的说法）"),
      "自检失败：注释里的提及被当成探测 ⇒ 死成员会被判成活的").toBe(false);
  });
});
