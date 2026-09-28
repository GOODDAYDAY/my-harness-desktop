// `BaseBackend` 的成员必须**两侧都活**：有调用方（壳真的调它）且有实现侧（内核/基类真的实现它）。
//
// ## 与数据字段契约的差别
//
// r129/r130 守的是数据字段（`BackendCreateOptions` / `KernelSpec`）："有人填 且 有人用"。
// `BaseBackend` 的成员是**方法**，所以"活性"的定义要换：
//   · **无调用方** ⇒ 死契约成员。r72 删掉的 `resume?(anchor)` 就是这一类
//     （接口里可选、基类有默认实现、但全仓没人调 ⇒ 读者以为壳支持"按锚点续跑"，其实从没发生过）。
//   · **无实现侧** ⇒ 契约要求了但没人兑现；由于 `AbstractBackend` 提供默认实现，
//     这种情况通常意味着"基类兜着、但没有内核真的做这件事"，同样是死的。
//   · **某内核没实现（但基类有默认）** ⇒ 这是 §1.5 的**缺面**，属合法状态，
//     但必须走三条出路之一（适配器翻译 / 内核插件补面 / 显式降级），
//     唯一禁止的是**静默缺面**。本守卫不判这一层（那需要逐内核比对，且 `capabilities` 轴
//     已经是它的表达方式，见 r50 的 `systemPrompt` 轴与 r128 的取证过程）。
//
// r131 实测：17 个成员（14 必实现 + 3 缺面默认 + 可选成员）**全部两侧都活**，
// 与 CLAUDE.md 对 `BaseBackend` 的记载吻合。本守卫把这个结论钉住。
//
// ## 判据形态（宁可窄而准，r130 的通则）
//
// · 调用方：`.<member>(` 出现在 application / controllers / web / bootstrap 语料里
// · 实现侧：`<member>(` 或 `async <member>(` 出现在 kernel / 内核插件语料里
// · 两侧都剥注释（r113/r125/r127）；语料含 `test-plugins`（r108：minimal/probe4 同级）

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CALL_ROOTS = ["src/server/application", "src/server/controllers", "src/web", "src/server/bootstrap"];
const IMPL_ROOTS = ["src/server/kernel", "src/plugins/kernels", "test-plugins/kernels"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
function strip(s0: string): string {
  const s = s0.replace(/\/\*[\s\S]*?\*\//g, "");
  return s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
}
function corpus(roots: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of roots) for (const f of walk(join(ROOT, r))) out.set(relative(ROOT, f), strip(readFileSync(f, "utf-8")));
  return out;
}

/** 从契约取 BaseBackend 的成员名（一级成员，含可选） */
function backendMembers(): { name: string; optional: boolean }[] {
  const s = readFileSync(join(ROOT, "packages/shared/src/domain/backend.ts"), "utf-8");
  const i = s.indexOf("export interface BaseBackend");
  expect(i, "契约里找不到 BaseBackend").toBeGreaterThan(-1);
  const body = s.slice(i, s.indexOf("\n}\n", i));
  return body.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .map((l) => {
      const m = /^ {2}(\w+)(\??)\s*[:(]/.exec(l);
      return m ? { name: m[1], optional: m[2] === "?" } : null;
    })
    .filter((x): x is { name: string; optional: boolean } => !!x);
}

describe("BaseBackend：每个成员都必须有调用方且有实现侧", () => {
  const members = backendMembers();
  const callers = corpus(CALL_ROOTS);
  const impls = corpus(IMPL_ROOTS);
  const calledBy = (n: string): string[] =>
    [...callers].filter(([, t]) => new RegExp(`\\.\\s*${n}\\s*\\(`).test(t)).map(([p]) => p);
  const implementedBy = (n: string): string[] =>
    [...impls].filter(([, t]) => new RegExp(`\\b(?:async\\s+)?${n}\\s*\\(`).test(t)).map(([p]) => p);

  it("判据不空转：成员数与文档记载一致，两侧语料非空且含 test-plugins", () => {
    // CLAUDE.md 记载：14 必实现 + 3 缺面默认（另有可选成员），r131 实测 17
    expect(members.length, `只解析出 ${members.length} 个成员（r131 实测 17）⇒ 契约解析可能坏了`).toBeGreaterThanOrEqual(15);
    for (const n of ["start", "stop", "sendMessage", "getTree", "getEntries", "abort", "setModel"]) {
      expect(members.map((m) => m.name), `六条核心意图相关的 ${n} 应在契约里`).toContain(n);
    }
    expect(callers.size, "调用方语料为空").toBeGreaterThan(60);
    expect(impls.size, "实现侧语料为空").toBeGreaterThan(30);
    expect([...impls.keys()].some((p) => p.startsWith("test-plugins/")),
      "实现侧语料里没有 test-plugins/ ⇒ minimal/probe4 的实现会被漏掉（r108 的教训）").toBe(true);
    // ⚠ 反空转锚：r72 删掉的死成员不得回潮
    expect(members.map((m) => m.name), "resume 是 r72 删除的死契约成员（无人调用），勿加回").not.toContain("resume");
  });

  it("① 每个成员都有**调用方**（壳真的调它，否则就是死契约成员）", () => {
    const dead = members.filter((m) => calledBy(m.name).length === 0).map((m) => m.name);
    expect(dead, [
      `${dead.length} 个 BaseBackend 成员没有任何调用方：${dead.join(", ")}`,
      "      含义：契约声明了、内核也实现了，但壳从来不调 ⇒ **死契约成员**。",
      "      r72 删掉的 resume?(anchor) 就是这一类：读者以为壳支持『按锚点续跑』，其实从没发生过。",
      "      处置：要么接上调用方（那通常意味着有个功能没做完），要么从契约删除并留退役说明（四条取证）。",
      "      ⚠ 可选成员（`name?`）也是成员：『可选』表达的是「某些内核可以没有」，不是「可以没人调」。",
    ].join("\n")).toEqual([]);
  });

  it("② 每个成员都有**实现侧**（基类或某个内核真的实现它）", () => {
    const dead = members.filter((m) => implementedBy(m.name).length === 0).map((m) => m.name);
    expect(dead, [
      `${dead.length} 个 BaseBackend 成员没有任何实现：${dead.join(", ")}`,
      "      含义：壳在调，但基类与所有内核都没实现 ⇒ 运行时必然 undefined is not a function。",
      "      若某成员只有部分内核实现、其余靠 AbstractBackend 的默认实现兜着，那是 §1.5 的**缺面**，",
      "      合法但必须走三条出路之一（适配器翻译 / 内核插件补面 / 显式降级），",
      "      并用 capabilities 轴把不对称变成可查询的事实（参考 r50 的 systemPrompt 轴）。",
    ].join("\n")).toEqual([]);
  });

  it("③ 自检：核心意图成员两侧都要命中（样本来自 r131 实测，不是编造的）", () => {
    for (const n of ["start", "stop", "sendMessage", "getTree", "abort", "setModel", "answerQuestion"]) {
      expect(members.map((m) => m.name), `${n} 应在契约里`).toContain(n);
      expect(calledBy(n).length, `${n} 的调用方应 >0`).toBeGreaterThan(0);
      expect(implementedBy(n).length, `${n} 的实现侧应 >0`).toBeGreaterThan(0);
    }
  });
});
