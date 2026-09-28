// `KernelSpec` 的字段必须**两侧都活**：有内核声明它（生产方）且共享机制读它（消费方）。
//
// ## 为什么守这个契约
//
// `KernelSpec` 是 §3.3「框架管通用，特化归外层」的落点：pi/dsh 共用的
// "装/查/状态合成"机制收进 `KernelManager` 基类，差异只是 `KernelSpec` **纯数据** + `postInstall` 钩子。
// 所以这个契约的每个字段都应当是"基类真的会读、且至少一个内核真的会填"的——
// 否则它就退化成"某个内核的专属配置塞进了共享契约"，加第四个内核时要被迫理解它。
//
// r130 实测：8 个字段（pkg / distTag / pkgJsonPath / extraPackages / cliWithinPkg /
// srcCli / srcPkgJson / cliJsLabel）**全部两侧都活**。本守卫把这个结论钉住。
//
// ## 两侧语料（r108/r129 的对称纪律）
//
// · 生产方：`src/plugins/kernels/**`、`test-plugins/kernels/**`、`src/server/kernel/**`
//   （内核插件声明自己的 spec；注意 test-plugins 必须在内——minimal/probe4 是同级内核，
//   r108 那次漏掉 test-plugins 造成 160 个假阳性）
// · 消费方：`src/server/kernel/core/**`（KernelManager 基类）、`src/server/bootstrap/**`、
//   `src/server/application/**`
// · 两侧都剥注释（r113/r125/r127 的纪律）
// · 消费判定只认 `spec.<field>` 形态（不认裸标识符，避免把无关同名变量算进来）

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROD_ROOTS = ["src/plugins/kernels", "test-plugins/kernels", "src/server/kernel"];
const CONS_ROOTS = ["src/server/kernel/core", "src/server/bootstrap", "src/server/application"];

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
function specFields(): string[] {
  const s = readFileSync(join(ROOT, "packages/shared/src/domain/kernel-manager.ts"), "utf-8");
  const i = s.indexOf("export interface KernelSpec");
  expect(i, "契约里找不到 KernelSpec").toBeGreaterThan(-1);
  const body = s.slice(i, s.indexOf("\n}", i));
  return body.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .map((l) => /^ {2}(\w+)\??\s*:/.exec(l)?.[1])
    .filter((x): x is string => !!x);
}

describe("KernelSpec：每个字段都必须有内核声明且被共享机制读取", () => {
  const fields = specFields();
  const prod = corpus(PROD_ROOTS);
  const cons = corpus(CONS_ROOTS);
  const producers = (f: string): string[] =>
    [...prod].filter(([, t]) => new RegExp(`\\b${f}\\s*:`).test(t)).map(([p]) => p);
  const consumers = (f: string): string[] =>
    [...cons].filter(([, t]) => new RegExp(`\\bspec\\.${f}\\b`).test(t)).map(([p]) => p);

  it("判据不空转：字段数正常、两侧语料非空、且**含 test-plugins**", () => {
    expect(fields.length, `只解析出 ${fields.length} 个字段（r130 实测 8）⇒ 契约解析可能坏了`).toBeGreaterThanOrEqual(7);
    expect(fields).toContain("pkg");
    expect(prod.size, "生产方语料为空").toBeGreaterThan(40);
    expect(cons.size, "消费方语料为空").toBeGreaterThan(20);
    // ⚠ r108 的教训：test-plugins 里的 minimal/probe4 与生产内核同级，漏掉它会造假阳性
    expect([...prod.keys()].some((p) => p.startsWith("test-plugins/")),
      "生产方语料里没有 test-plugins/ ⇒ minimal/probe4 声明的字段会被误判成无生产方").toBe(true);
  });

  it("① 每个字段都有**生产方**（至少一个内核在自己的 spec 里填它）", () => {
    const dead = fields.filter((f) => producers(f).length === 0);
    expect(dead, [
      `${dead.length} 个 KernelSpec 字段没有内核声明：${dead.join(", ")}`,
      "      含义：基类会读它，但没有任何内核填 ⇒ 那条逻辑永远走 undefined 分支。",
      "      处置：要么让需要的内核声明它，要么从契约删掉并留退役说明（参考 r128 的 maxTokens）。",
    ].join("\n")).toEqual([]);
  });

  it("② 每个字段都有**消费方**（KernelManager 基类/组装层真的读 spec.X）", () => {
    const dead = fields.filter((f) => consumers(f).length === 0);
    expect(dead, [
      `${dead.length} 个 KernelSpec 字段没有被共享机制读取：${dead.join(", ")}`,
      "      含义：内核在填，但基类不读 ⇒ 它是**某个内核的专属配置混进了共享契约**。",
      "      按 §3.3，共享契约只收『多个调用方逻辑相同、差别只在参数』的部分；",
      "      专属配置应留在该内核自己的目录里（由它的工厂闭包捕获，§1.1 判别气味四）。",
      "      ⚠ 若消费方其实在别处（例如某内核的 manager 子类读 spec.X），",
      "      先确认那是否属于『共享机制』——子类读自己的专属字段，恰恰说明它不该在共享契约里。",
    ].join("\n")).toEqual([]);
  });

  it("③ 自检：已知的活字段两侧都要命中（样本来自 r130 实测）", () => {
    for (const f of ["pkg", "distTag", "pkgJsonPath", "cliWithinPkg"]) {
      expect(fields, `${f} 应在契约里`).toContain(f);
      expect(producers(f).length, `${f} 的生产方应 >0`).toBeGreaterThan(0);
      expect(consumers(f).length, `${f} 的消费方应 >0（KernelManager 基类读 spec.${f}）`).toBeGreaterThan(0);
    }
  });
});
