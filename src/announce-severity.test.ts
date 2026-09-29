// 失败播报的**级别**对账（r202）。
//
// ## 钉的性质
//
// `announceTransient(msg, variant)` 的 variant **默认是 "info"**，而 `role="alert"`
// **只在 variant === "error" 时才设**（live-region.tsx:46-51）。
// `role=alert` 是读屏的**打断**语义：没有它，失败提示只是安静地出现在页面某处，
// 用读屏的用户不会被打断、大概率完全不知道操作失败了——**等于没播报**。
// 所以：**catch 块里的 announceTransient 必须显式传 "error"**。
//
// ## 为什么这条能交成守卫（r192 的判据：命中集可机械复核吗）
//
// 判据只看两件事，都是封闭形态：① 调用点在不在 catch 块内（花括号配对）；
// ② 配对的实参里有没有 `"error"` 字面量。不涉及"这算不算失败"这类语义判断。
//
// ⚠ 首版判据写错过（本轮实测）：用 `announceTransient\(([^;]{0,200}?)\)\s*;` 取实参，
//   正则在**内层 `t(…)` 的右括号**就截断了 ⇒ 把"级别写在下一行"的多行形态
//   全部误判成"无级别"，报出 6 处假阳性（其中 5 处其实都显式传了 "error"）。
//   改成**括号配对**取实参后，真实命中只有 1 处（且是正当的 info，见账本）。
//   这是 r181 那条教训的重现：**遇到嵌套语法就别用正则解析它**。
//
// ⚠ 行号纪律（r171/r182/r194）：剥注释只用于匹配，行号在**原文件**上算。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ROOTS = ["src", "packages/react/src", "packages/shared/src"];

/** 正当的 info 级播报账本（每条要有理由；catch 内的 info 必须在这里登记）。 */
const LEDGER: { file: string; key: string; reason: string }[] = [
  // r192：goal 的斜杠命令在"当前无目标"时的响应——它是**信息**（没有可暂停/恢复的目标），
  // 不是失败；用户需要知道"命令收到了、但没有目标"，不需要被打断式告警。
  // ⚠ 它其实不在 catch 内（本轮实测：首版扫描的行号来自剥离后文本、定位偏了），
  //   登记在这里是为了让"catch 内必须是 error"这条判据将来若把它扫进来时有据可依。
  { file: "src/plugins/sessions/goal/renderer/goal-controller.ts", key: "goal.noGoal",
    reason: "斜杠命令的信息性响应（当前无目标），不是失败 ⇒ info 级正确（r192）" },
];

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
/** 该位置是否在一个**未闭合的 catch 块**内（花括号配对，不是行窗口）。 */
function insideCatch(s: string, at: number): boolean {
  const ci = s.lastIndexOf("catch", at);
  if (ci < 0) return false;
  const brace = s.indexOf("{", ci);
  if (brace < 0 || brace > at) return false;
  let d = 0;
  for (let j = brace; j < at; j++) {
    if (s[j] === "{") d++;
    else if (s[j] === "}") { d--; if (d === 0) return false; }
  }
  return d > 0;
}

interface Hit { file: string; line: number; args: string }

function scan(): { hits: Hit[]; inCatch: number; total: number } {
  const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const hits: Hit[] = [];
  let inCatch = 0, total = 0;
  for (const f of files) {
    const rawFile = readFileSync(f, "utf-8");
    const s = strip(rawFile);
    const rel = relative(ROOT, f);
    for (const m of s.matchAll(/announceTransient\s*\(/g)) {
      const p = s.indexOf("(", m.index!);
      const e = matchParen(s, p);
      if (e < 0) continue;
      total++;
      const args = s.slice(p + 1, e);
      if (!insideCatch(s, m.index!)) continue;
      inCatch++;
      if (/"error"/.test(args)) continue;
      const occ = [...s.slice(0, m.index!).matchAll(/announceTransient\s*\(/g)].length;
      const rawIdx = [...rawFile.matchAll(/announceTransient\s*\(/g)][occ]?.index ?? m.index!;
      hits.push({ file: rel, line: rawFile.slice(0, rawIdx).split("\n").length, args: args.replace(/\s+/g, " ").slice(0, 80) });
    }
  }
  return { hits, inCatch, total };
}

describe("失败播报的级别：catch 内必须显式 error（否则读屏不打断，等于没播报）", () => {
  const r = scan();

  it("判据不空转：扫到了播报调用点，且大多数在 catch 内（失败播报是它的主要用途）", () => {
    expect(r.total, `announceTransient 调用点（r202 括号配对后实测 18）：${r.total}`).toBeGreaterThan(10);
    expect(r.inCatch, "其中在 catch 块内的（r202 实测 16）").toBeGreaterThan(10);
  });

  it("① catch 内的播报必须显式传 \"error\"（默认是 info ⇒ 无 role=alert ⇒ 读屏不打断）", () => {
    const ledgered = (h: Hit): boolean =>
      LEDGER.some((e) => h.file.endsWith(e.file.split("/").pop()!) && h.args.includes(e.key));
    const bad = r.hits.filter((h) => !ledgered(h));
    expect(bad.map((h) => `${h.file}:${h.line}  args=${h.args}`), [
      "catch 块里的 announceTransient 必须显式传 \"error\"。",
      '      原因：variant 默认是 "info"，而 role="alert" 只在 variant === "error" 时才设',
      "      （packages/react/src/widgets/live-region.tsx:46-51）。没有 role=alert，",
      "      失败提示只是安静地出现在页面某处——用读屏的用户不会被打断、",
      "      大概率完全不知道操作失败了，**等于没播报**（§7.6 的显式降级要求可感知）。",
      "      修法：announceTransient(msg, \"error\")。",
      "      若这确实是信息性提示而非失败，把它登记进本文件的 LEDGER 并写明理由。",
    ].join("\n")).toEqual([]);
  });

  it("② 账本自检：每条登记的理由非空，且账本里没有已失效的条目（对应调用点仍存在）", () => {
    for (const e of LEDGER) {
      expect(e.reason.length, "每条账本都要写明理由").toBeGreaterThan(10);
      const src = readFileSync(join(ROOT, e.file), "utf-8");
      expect(src.includes(e.key), `账本条目 ${e.file} 的 ${e.key} 在源码里已找不到 ⇒ 账本失效，应删除`).toBe(true);
    }
  });
});
