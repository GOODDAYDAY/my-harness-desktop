// 禁止在插件层给 ctx.config.set 再包一层失败播报（r217；钉住 r216 那次回退）。
//
// ## 背景
//
// `ctx.config.set` 在**框架层已经播报**：`packages/react/src/plugin-context.ts:41-52`
// 的 `.catch(announceTransient(i18next.t("shell.configWriteFailed", …), "error") 后 throw)`（r82）。
// r183/r197/r198/r215 四轮里我又在插件层给它包了 `fireAndReport` / `announceTransient`，
// 结果是**一次配置写失败弹两条提示**（违反 r187/r206 的"处置只应发生一次"与 §3.3）；
// r216 回退了 9 处并删掉 28 条死键。
//
// 本守卫就是钉住那次回退：**插件层不许再出现"包着 ctx.config.set 的播报"**。
//
// ## 为什么这条能交硬断言（0 命中）
//
// 判据是**封闭形态**（r192：命中集可否机械复核）——
// `fireAndReport(` 或 `announceTransient(` 的**配对实参里**出现 `ctx.config.set` /
// `config.set(`。这是语法形状，不涉及"这算不算失败反馈"这类语义判断。
//
// ⚠ 已知边界（如实标注）：判据只看"播报调用的实参里有没有 config.set"，
//   所以"先 await config.set 到变量、再在 catch 里播报"这种间接形态**看不见**——
//   但那种形态本来就是正当的（调用方自己 try/catch 是 r82 注释明写允许的：
//   "已经自己 try/catch 的调用方行为完全不变"），所以看不见也没关系。
//   真正要防的是"框架播报 + 插件再播报"这种**同一失败两次提示**，而它必然表现为
//   播报调用的实参里直接裹着 config.set。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ROOTS = ["src/plugins", "src/web", "packages/react/src"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && name !== "locales" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
function strip(s0: string): string {
  return s0.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .map((l) => (l.trim().startsWith("//") ? "" : l)).join("\n");
}
function matchParen(s: string, i: number): number {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "(") d++;
    else if (s[j] === ")") { d--; if (d === 0) return j; }
  }
  return -1;
}

interface Hit { file: string; line: number; expr: string }

function scan(): { hits: Hit[]; announces: number } {
  const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const hits: Hit[] = [];
  let announces = 0;
  for (const f of files) {
    const rawFile = readFileSync(f, "utf-8");
    const s = strip(rawFile);
    const rel = relative(ROOT, f);
    for (const m of s.matchAll(/\b(fireAndReport|announceTransient)\s*\(/g)) {
      const p = s.indexOf("(", m.index!);
      const e = matchParen(s, p);
      if (e < 0) continue;
      announces++;
      const args = s.slice(p + 1, e);
      if (!/config\s*\.\s*set\s*\(/.test(args)) continue;
      const occ = [...s.slice(0, m.index!).matchAll(/\b(fireAndReport|announceTransient)\s*\(/g)].length;
      const rawIdx = [...rawFile.matchAll(/\b(fireAndReport|announceTransient)\s*\(/g)][occ]?.index ?? m.index!;
      hits.push({ file: rel, line: rawFile.slice(0, rawIdx).split("\n").length, expr: args.replace(/\s+/g, " ").slice(0, 80) });
    }
  }
  return { hits, announces };
}

describe("插件层不许给 ctx.config.set 再包一层播报（框架层 r82 已播报 ⇒ 双重提示）", () => {
  const r = scan();

  it("判据不空转：扫到了播报调用点（否则判据可能在漏，命中 0 就毫无意义）", () => {
    expect(r.announces, `fireAndReport / announceTransient 调用点总数（r217 实测应 > 10）：${r.announces}`).toBeGreaterThan(10);
  });

  it("① 播报调用的实参里不许直接裹着 config.set（0 命中；r216 已回退 9 处）", () => {
    expect(r.hits.map((h) => `${h.file}:${h.line}  ${h.expr}`), [
      "ctx.config.set 在**框架层已经播报**（packages/react/src/plugin-context.ts:41-52，r82：",
      "      .catch(announceTransient(shell.configWriteFailed, 'error') 后重新抛出）。",
      "      插件层再包一层 ⇒ 一次配置写失败**弹两条提示**，违反'处置只应发生一次'（r187/r206）与 §3.3。",
      "      修法：直接 `void ctx.config.set(key, value)`（或 await 它并自己 try/catch，但不要播报）。",
      "      参照 r216 的回退提交（9 处 + 删 28 条死键）。",
    ].join("\n")).toEqual([]);
  });
});
