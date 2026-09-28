// `BackendCreateOptions` 的字段必须**两侧都活**：有人填（生产方）且有人用（消费方）。
//
// ## 为什么要有这条守卫
//
// r128 查出 `maxTokens` 是死字段并删除了它。取证过程暴露了一个通用风险：
// **中立契约的字段可以长期"半活"**——
//   · 只有生产方、没有消费方（壳在填，所有内核都忽略）⇒ 读者以为壳能控制某件事，其实不能；
//   · 只有消费方、没有生产方（内核会用，但没人填过）⇒ 那条代码路径永远走 undefined 分支。
// `agentDir` 是前者（每个实现都忽略 ⇒ 已删），`maxTokens` 是后者（dsh 会消费、但没人填 ⇒ r128 删）。
//
// 契约注释自己写了判据：「契约只收**壳必须向每一个内核索要**的中性字段」。
// 这条守卫把那句话变成机器可判的，并且**为"第四个内核"兜底**：
// 加内核时最容易发生的事，就是给契约加一个"某个内核需要"的字段——
// 而按 §1.5，那属于内核专属能力，应该走适配器翻译/内核插件补面/显式降级，不进中立契约。
//
// ## 判据（两侧语料必须对称，r108 的纪律）
//
// · **生产方语料**：`src/server/application/**`、`src/web/**`、`src/server/bootstrap/**`
//   ——构造 `BackendCreateOptions` 对象字面量的地方（`factory.create({ … })`）。
// · **消费方语料**：`src/server/kernel/**`、`src/server/bootstrap/**`、
//   `src/plugins/kernels/**`、`test-plugins/kernels/**`
//   ——读 `opts.<field>` 的地方。
// ⚠ **`bootstrap/` 必须同时在两侧**：路由工厂 `50-wiring.ts` 的
//   `kernelRegistry.get(opts.kernel)` 就是 `kernel` 字段的消费方，
//   而 `assemble.ts` 也参与构造。r129 首版把 bootstrap 只算生产方，
//   于是 `kernel` 被误报成"无消费方"——**语料划错一侧就会造假阳性**。
// · 两侧都**剥注释**（r113/r125 的纪律：对账判据两侧预处理必须一致）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROD_ROOTS = ["src/server/application", "src/web", "src/server/bootstrap"];
const CONS_ROOTS = ["src/server/kernel", "src/server/bootstrap", "src/plugins/kernels", "test-plugins/kernels"];

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

/** 从契约里取字段名（interface 体内的一级成员） */
function contractFields(): string[] {
  const s = readFileSync(join(ROOT, "packages/shared/src/domain/backend.ts"), "utf-8");
  const i = s.indexOf("export interface BackendCreateOptions {");
  expect(i, "契约里找不到 BackendCreateOptions（文件被改名/搬走了？）").toBeGreaterThan(-1);
  const j = s.indexOf("\n}", i);
  const body = s.slice(i, j);
  // 只取一级成员（两空格缩进的 `name?:` / `name:`），跳过注释行
  return body.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .map((l) => /^ {2}(\w+)\??\s*:/.exec(l)?.[1])
    .filter((x): x is string => !!x);
}

describe("BackendCreateOptions：每个字段都必须有人填且有人用", () => {
  const fields = contractFields();
  const prod = corpus(PROD_ROOTS);
  const cons = corpus(CONS_ROOTS);

  const producers = (f: string): string[] =>
    [...prod].filter(([, t]) => new RegExp(`\\b${f}\\s*:`).test(t)).map(([p]) => p);
  const consumers = (f: string): string[] =>
    [...cons].filter(([, t]) => new RegExp(`\\b(?:opts|options|o)\\.${f}\\b`).test(t)).map(([p]) => p);

  it("判据不空转：契约字段数正常，且两侧语料都非空", () => {
    expect(fields.length, `只解析出 ${fields.length} 个字段（r129 实测 9）⇒ 契约解析正则可能坏了`).toBeGreaterThanOrEqual(8);
    expect(fields).toContain("cwd");
    expect(fields).toContain("kernel");
    expect(prod.size, "生产方语料为空 ⇒ 路径判据坏了").toBeGreaterThan(50);
    expect(cons.size, "消费方语料为空 ⇒ 路径判据坏了").toBeGreaterThan(20);
    // ⚠ 反空转锚：r128 删掉的 maxTokens 不该再出现在契约里
    expect(fields).not.toContain("maxTokens");
    expect(fields, "agentDir 是已退役字段（契约里有退役说明，勿加回）").not.toContain("agentDir");
  });

  it("① 每个字段都有**生产方**（有人在构造 opts 时填它）", () => {
    const dead = fields.filter((f) => producers(f).length === 0);
    expect(dead, [
      `${dead.length} 个契约字段没有任何生产方：${dead.join(", ")}`,
      "      含义：内核侧会读它，但壳从来不填 ⇒ 那条代码路径永远走 undefined 分支。",
      "      r128 删掉的 maxTokens 就是这一类（dsh 的 initialize 握手会用它，但全仓没人赋值）。",
      "      处置：要么补上生产方（UI/pref → application 传入），要么把字段从契约删掉并留退役说明。",
      "      ⚠ 不要只给它加能力轴做'显式降级'——给一条从不通电的线装指示灯没有意义（§17.127）。",
    ].join("\n")).toEqual([]);
  });

  it("② 每个字段都有**消费方**（有内核/路由真的读它）", () => {
    const dead = fields.filter((f) => consumers(f).length === 0);
    expect(dead, [
      `${dead.length} 个契约字段没有任何消费方：${dead.join(", ")}`,
      "      含义：壳在填，但所有内核都忽略 ⇒ 读者以为壳能控制某件事，其实不能。",
      "      已退役的 agentDir 就是这一类（每个实现都忽略它）。",
      "      处置：要么让需要的内核消费它（适配器翻译/内核插件补面），要么从契约删掉。",
      "      ⚠ 若某字段的消费方在**路由层**（bootstrap 的工厂按 opts.kernel 分派），",
      "      确认 CONS_ROOTS 含 src/server/bootstrap —— r129 首版漏了它，把 kernel 误报成无消费方。",
    ].join("\n")).toEqual([]);
  });

  it("③ 自检：已知的活字段两侧都要命中（否则判据在漏，①② 会通过得很假）", () => {
    // 样本来自 r129 的实测分布，不是编造的
    for (const f of ["cwd", "kernel", "provider", "model", "neutralSessionId", "lineageId", "ephemeral"]) {
      expect(fields, `${f} 应在契约里`).toContain(f);
      expect(producers(f).length, `${f} 的生产方应 >0（r129 实测：cwd 15 / kernel 11 / provider 6 …）`).toBeGreaterThan(0);
      expect(consumers(f).length, `${f} 的消费方应 >0`).toBeGreaterThan(0);
    }
    // kernel 的消费方必须包含路由工厂（这是最容易被语料划分漏掉的一个）
    expect(consumers("kernel").some((p) => p.includes("50-wiring")),
      "kernel 的消费方应包含 bootstrap 的路由工厂 50-wiring.ts（kernelRegistry.get(opts.kernel)）").toBe(true);
  });
});
