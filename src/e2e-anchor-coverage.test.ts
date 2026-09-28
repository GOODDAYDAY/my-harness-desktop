// e2e 锚点存在性守卫(静态,零 IO)。
//
// 动机:e2e 靠 `[data-*]` 选择器等元素。**若某个锚点在源码里已不存在,那条断言就是在空转**
// (等一个永远不会出现的元素)——而本仓 e2e 不随单测自动跑,改锚点名时不会有人立刻发现。
//
// 判据两侧**都自动派生**,不写任何手写清单(手写清单会过期,这是本仓反复吃过的亏):
//   ① e2e 侧:从 scripts/demo/*.e2e.mjs 里抽 `[data-xxx...` 的锚点名;
//   ② 源码侧:从 src/、packages/ 的 ts/tsx 里抽所有 `data-*` 字面量。
// 断言 ① ⊆ ②。can go red:把源码里的 `data-foo` 改名、或 e2e 里写个不存在的锚点。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** e2e 里用到的锚点名(不含 `data-` 前缀)。 */
function anchorsUsedByE2e(): Set<string> {
  const out = new Set<string>();
  const dir = join(ROOT, "scripts/demo");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".e2e.mjs")) continue;
    // ⚠ 必须**剥注释**再抽(r113)：判据两侧要对称(发出侧已剥，r108 的教训)。
    //   实测反例：settings-controls-audit 里那段"记录 r112 修掉空探针"的注释中
    //   引用了旧选择器 [data-settings-id][data-active]，于是**注释被当成探针**，
    //   报出 data-active / data-panel 两个"e2e 依赖但源码没有"的锚点——
    //   而它们其实一个都没被真的查询。文档性注释引用旧锚点是合法的(退役说明就该这么写)。
    const raw = readFileSync(join(dir, f), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    const text = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const m of text.matchAll(/\[data-([a-z0-9-]+)[\]=]/g)) out.add(m[1]);
  }
  return out;
}

/** 源码里**真正发出**的 `data-*` 属性(含前缀)。
 *
 *  ⚠ r113 修掉一个"守卫声称的能力与实际不符"的缺陷(r112 发现)：
 *  首版判据是 `/data-[a-z0-9-]+/g` 扫 src+packages 的**所有** .ts/.tsx —— 也就是
 *  **注释里、测试文件里、字符串里出现过就算"源码里存在"**。于是 dom-audit 剧本里那两个
 *  想象出来的锚点(data-section / data-panel)因为在某处注释中被提到而被判为"存在"，
 *  断言恒过 —— 而文件头写的正是"e2e 不该依赖想象中的锚点"。
 *
 *  现在的判据(与 data-anchor-consumers.test.ts 的发出侧同款，两处必须一致)：
 *    · 只看**生产代码**(排除 *.test.ts(x))；
 *    · **剥掉块注释与整行注释**再匹配(退役说明里引用旧锚点是合法的，不该算发出)；
 *    · 只认**属性位置**：`data-x` 后面跟 = : { " ' ` ) / > 空白 或行尾
 *      (覆盖 JSX 裸属性形态 —— r111 查明漏了它会少算 21 种)。
 */
function anchorsInSource(): Set<string> {
  const out = new Set<string>();
  const EMIT = /\b(data-[a-z][\w-]*)(?=[\s=:{"'`)/>]|$)/g;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "out" || entry === "dist") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        const raw = readFileSync(p, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
        const code = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        for (const m of code.matchAll(EMIT)) out.add(m[1]);
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "packages"));
  walk(join(ROOT, "test-plugins"));
  return out;
}

describe("e2e 锚点 ↔ 源码 data-* 存在性", () => {
  const used = anchorsUsedByE2e();
  const defined = anchorsInSource();

  it("两侧都非空(判据本身不空转)", () => {
    expect(used.size).toBeGreaterThan(0);
    expect(defined.size).toBeGreaterThan(0);
  });

  /**
   * 由**第三方库**发出的锚点（r113）：我们的源码里没有它，但它在真实 DOM 里存在，
   * 所以剧本探测它是合法的。每条写明是哪个库发出的——这与 r110 的 CSS 变量普查
   * 是同一类"发出方在语料之外"，也是 r108"两侧语料必须对称"的边界情形：
   * 语料对称管的是"仓库内的两侧"，库发出的属性天然在仓库外，只能显式登记。
   * ⚠ 这不是豁免表：新增一条必须写明库名与它发出的属性，且要能在 DOM 里实测到。
   */
  const LIBRARY_EMITTED = new Map<string, string>([
    // react-resizable-panels（Panel/PanelGroup）在真实 DOM 上渲染 data-panel=""、
    // data-panel-group=""、data-panel-size 等；sidebar 与设置页的分栏都靠它。
    // 实测证据：sidebar.test.tsx 断言 container.querySelectorAll('[data-panel=""]').length === 2。
    ["panel", "react-resizable-panels 的 <Panel>"],
    ["panel-group", "react-resizable-panels 的 <PanelGroup>"],
    ["panel-size", "react-resizable-panels（尺寸态）"],
    ["panel-resize-handle", "react-resizable-panels 的 <PanelResizeHandle>"],
  ]);

  it("e2e 用到的每个锚点在源码里都存在（或登记为库发出）", () => {
    const missing = [...used].filter((a) => !defined.has(`data-${a}`) && !LIBRARY_EMITTED.has(a)).sort();
    expect(
      missing.map((m) => `data-${m}`),
      [
        `e2e 依赖但源码里没有、也没登记为库发出的锚点: ${missing.join(", ")}`,
        "      两种可能：① 剧本在探测一个**想象出来的**锚点（那就是空探针，选择器恒不匹配、",
        "         这一维实际没被验，r112 在 dom-audit 里抓到过两个）；",
        "      ② 该锚点由**第三方库**发出（合法，但要写进上面的 LIBRARY_EMITTED 并注明库名）。",
        "      ⚠ 本判据 r113 才收紧：此前它把**注释里、测试文件里出现过**也算'源码里存在'，",
        "      于是 dom-audit 的 data-section / data-panel 两个想象锚点长期蒙混过关，",
        "      而文件头写的正是'e2e 不该依赖想象中的锚点'——守卫声称的能力必须实测过一次才算数。",
      ].join("\n"),
    ).toEqual([]);
    // 账本不许腐：登记的库锚点若哪天在我们源码里也发出了，就该删条目（仿 r83/r111 的腐烂检查）
    const stale = [...LIBRARY_EMITTED.keys()].filter((a) => defined.has(`data-${a}`));
    expect(stale, `这些锚点源码里已经有了，从 LIBRARY_EMITTED 删掉：${stale.join()}`).toEqual([]);
  });
});

// ---- 第二部分：`.claude/skills/interaction-testing/SKILL.md` §2 的锚点清单不许腐烂 ----
//
// 为什么单独守 skill：它是写 e2e 时的**实操查阅处**（§2「DOM 锚点清单(实测有效)」）。
// 清单一旦过期，下一个人照它写就会命中不存在的元素——症状是 `waitForSelector` 超时，
// 然后他"顺手"改成按文案匹配（`/^(设置|Settings)$/`），于是测试被绑死在某一种语言上
// （zh-TW 是「設定」，实测就这么失效过）。**锚点清单腐烂是"按文案定位"这个反模式的上游成因**，
// 所以要在源头守住。
//
// ⚠ 只取表格的**第一列**：第二列是说明文字，里面会刻意提到反例
// （如"别改用 react-resizable-panels 的 `data-panel-id`"——那是第三方库属性、本仓源码里没有），
// 整行扫描会把这类**告诫**误判成违规。
describe("skill §2 锚点清单 ↔ 源码存在性（防清单腐烂）", () => {
  const SKILL = join(ROOT, ".claude/skills/interaction-testing/SKILL.md");

  it("skill 文件存在且 §2 表格非空（判据不空转）", () => {
    expect(existsSync(SKILL), `找不到 ${SKILL}`).toBe(true);
    expect(anchorsInSkill().length, "§2 一个锚点都没抽到 = 解析错了（假绿）").toBeGreaterThanOrEqual(8);
  });

  it("§2 清单里的每个锚点在源码里都存在", () => {
    const defined = anchorsInSource();
    const missing = anchorsInSkill().filter((a) => !defined.has(`data-${a}`)).sort();
    expect(
      missing.map((m) => `data-${m}`),
      `skill §2 列了但源码里没有的锚点（清单已腐烂，照它写 e2e 会超时）: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

/** 抽 SKILL.md §2 表格第一列里的 `data-*` 名。 */
function anchorsInSkill(): string[] {
  const text = readFileSync(join(ROOT, ".claude/skills/interaction-testing/SKILL.md"), "utf-8");
  const start = text.indexOf("## 2 DOM 锚点清单");
  if (start < 0) return [];
  const end = text.indexOf("\n## 3 ", start);
  const section = text.slice(start, end > 0 ? end : undefined);
  const out = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";      // 只取第一列
    for (const m of firstCell.matchAll(/data-([a-z0-9-]+)/g)) out.add(m[1]);
  }
  return [...out];
}
