// `void <promise>` **发射后不管**的普查（棘轮 + 反空转锚，r181）。
//
// ## 为什么需要这条（r180 的直接衍生）
//
// r180 修了 session-bookmarks 的两处 `void ctx.config.set("bookmarkOrder", …)`——
// 写失败时用户的新顺序**静默不落盘、零反馈**（§7.6 禁止的静默失败）。
// 当时以为 r85 那条守卫（`unhandled-async-scope`）该抓到它，实测**抓不到**：
// r85 扫的是 **`await` 站点**，而 `void <promise>` 是**另一类缺陷**——
// 它不是"await 了但没兜住"，而是"根本没等，连错误一起丢了"。
//
// > `void p` 与 `void p.catch(h)` 的差别是**有没有留下错误**：
// > 前者把结果与错误**都**丢了，后者丢结果、留错误（正确形态）。
// > 而 `void` 这个关键字读起来像"我不关心结果"，容易让人以为"这里不需要处理"——
// > 实际上"不关心结果"与"不关心失败"是两件事。
//
// ## 判据（r181 实测调过两次，都如实记）
//
// · 只认**语句位置**的 `void <标识符…>`（前面是行首/`;`/`{`/`}`/`=> `/`( `/`, `）；
//   ⚠ 首版不限位置 ⇒ 命中 **896** 处，绝大多数是**类型位置**的 void
//   （`(): void {`、`=> void`、`Promise<void>`）⇒ 判据完全不可用。
// · 表达式用**括号配对**取（含后续链式 `.then/.catch`）；
//   ⚠ 首版用 `split(";")[0].split("\n")[0]` ⇒ 跨行表达式被截断，
//   出现"表达式为空"与把 `setTimeout(… void f(x), 1000)` 的实参误解析成表达式。
// · 表达式里含 `.catch(` ⇒ 已保护，不计。
//
// ## 已知缺口（如实标注，不当作已解决）
//
// 括号配对之后仍有 **23 处**表达式提取为空（多为跨行/嵌套模板串形态），
// 它们**没有被计入**基数 ⇒ 真实债务 ≥ 基线。修好提取后基线可能上调；
// 这不影响棘轮的作用（防增长），但读这个数字时要知道它是**下界**。
//
// ## 为什么是棘轮而不是硬断言 0
//
// 实测 **270** 处未保护，其中大量是**正当的**发射后不管：
// `notify.show(…)`（通知是尽力而为，失败不该打扰用户——r122 已判）、
// `p.dispose?.()`（清理路径）、编排器内部的 `settle/onParentDead`（自身有保护）。
// 一轮分类不完 ⇒ 按 r85 的先例交"棘轮 + 锚"：棘轮保证债务不增长，
// 锚保证判据不退化，分类留给后续轮次消化。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ROOTS = ["src", "packages/react/src", "packages/shared/src"];

/** r181 实测 270（另有 23 处提取失败未计入 ⇒ 这是**下界**）。 */
const CEILING = 243;   // r196 修掉 4 处 abort（+收敛带来的连带减少）⇒ 250 → 243（实测值）

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
  const s = s0.replace(/\/\*[\s\S]*?\*\//g, "");
  return s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
}

/** 从 i 处的 `(` 开始做括号配对，返回配对后的结束下标（找不到返回 -1）。 */
function matchParen(s: string, i: number): number {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "(") d++;
    else if (s[j] === ")") { d--; if (d === 0) return j; }
  }
  return -1;
}

/**
 * **自保护原语**豁免表（r187）：这些函数**内部已经兜住了错误**（catch + 播报），
 * 从不向调用方 reject ⇒ 调用点的 `void f(...)` **不是**发射后不管的债务。
 *
 * ⚠ 豁免表最容易烂掉：某天有人把原语里的 catch 删了，调用点全都变成裸奔，
 *   而豁免表还在替它们打掩护。所以 ② 那条测试会**回读原语实现**，
 *   断言它确实含 catch（豁免的前提必须持续成立，不能只在建表时核一次）。
 */
const SELF_PROTECTING: { name: string; impl: string; reason: string }[] = [
  { name: "copyToClipboard", impl: "packages/react/src/widgets/clipboard.ts",
    reason: "r134 收敛的原语：内部 catch + 播报 clipboardFailed/clipboardUnavailable，返回 boolean 不 reject" },
  { name: "pickDirectory", impl: "packages/react/src/widgets/pick-directory.ts",
    reason: "r137 收敛的原语：内部 catch + 播报 directoryPickerFailed，返回 string|null 不 reject" },
  { name: "fireAndReport", impl: "packages/react/src/widgets/fire-and-report.ts",
    reason: "r185 收敛的原语：它**就是**失败处置本身（catch + warn + 播报）" },
];

/**
 * 该文件是否**从别处 import** 了这个名字（而不是自己在本文件里定义的同名函数）。
 * 判据：存在 `import { … name … } from "…"` 且 name 出现在花括号里（含 `as` 别名的原名位置）。
 * ⚠ 只认 import：本地定义的同名函数**不算**——它是否自保护要看它自己的实现，
 *   而那不是豁免表在担保的东西（r189）。
 */
function importsFrom(raw: string, name: string): boolean {
  for (const m of raw.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) {
    const names = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].trim());
    if (names.includes(name)) return true;
  }
  return false;
}

interface Hit { file: string; line: number; expr: string }

function scan(): { hits: Hit[]; unparsed: number; total: number; withCatch: number; selfProtected: number } {
  const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const STMT = /(?:(?<=^)|(?<=[;{}])|(?<==>\s)|(?<=\(\s)|(?<=,\s))\s*void\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:\(|\b))/g;
  const hits: Hit[] = [];
  let unparsed = 0, total = 0, withCatch = 0, selfProtected = 0;
  for (const f of files) {
    const rawFile = readFileSync(f, "utf-8");
    const s = strip(rawFile);
    const rel = relative(ROOT, f);
    for (const m of s.matchAll(STMT)) {
      total++;
      let expr: string;
      const openIdx = m.index + m[0].indexOf("void");
      const paren = s.indexOf("(", openIdx);
      const nameEnd = openIdx + m[0].slice(m[0].indexOf("void")).trim().length;
      if (paren >= 0 && paren <= nameEnd + 2) {
        const close = matchParen(s, paren);
        if (close < 0) { unparsed++; continue; }
        expr = s.slice(openIdx, close + 1);
        // 吃掉后续链式 .then(...) / .catch(...)
        let k = close + 1;
        for (;;) {
          const dot = s.slice(k).match(/^\s*\.\s*[A-Za-z_$][\w$]*\s*\(/);
          if (!dot) break;
          const p2 = s.indexOf("(", k + dot[0].length - 1);
          const c2 = matchParen(s, p2);
          if (c2 < 0) { unparsed++; break; }
          expr = s.slice(openIdx, c2 + 1);
          k = c2 + 1;
        }
      } else {
        const e = s.slice(openIdx, openIdx + 120).split("\n")[0].trim();
        if (!e) { unparsed++; continue; }
        expr = e;
      }
      if (!expr.trim()) { unparsed++; continue; }
      if (expr.includes(".catch(")) { withCatch++; continue; }
      // r187：调用**自保护原语**的 void 不算债务（原语内部已兜住、从不 reject）
      // ⚠ r189 收紧为 **import 感知**：首版只比对被调方的**叶子名**，这是不成立的判据——
      //   实测同名函数在不同文件里保护状态**不同**（`refresh` 有 6 个定义：2 个带 catch、4 个不带；
      //   `reload` 2 个定义一带一不带）。按名字豁免 ⇒ 某个插件自己定义一个**不带保护**的
      //   `copyToClipboard`，就会被错误豁免（r159 的教训：按语义分类、不按名字/形态）。
      //   正确判据：**该文件确实从原语所在的模块 import 了这个名字** ⇒ 它调的才是那个自保护实现。
      const callee = /^void\s+([A-Za-z_$][\w$.]*)/.exec(expr.trim())?.[1] ?? "";
      const leaf = callee.split(".").pop() ?? "";
      const exempt = SELF_PROTECTING.find((x) => x.name === leaf);
      if (exempt && importsFrom(rawFile, exempt.name)) { selfProtected++; continue; }
      hits.push({ file: rel, line: s.slice(0, m.index).split("\n").length, expr: expr.replace(/\s+/g, " ").slice(0, 90) });
    }
  }
  return { hits, unparsed, total, withCatch, selfProtected };
}

describe("`void <promise>` 发射后不管：未保护数只许减少", () => {
  const r = scan();

  it("判据不空转：语料规模、类型位置的 void 不被计入、已保护的被正确排除", () => {
    expect(r.total, `语句位置 void 命中数（r181 实测 333）：${r.total}`).toBeGreaterThan(200);
    expect(r.withCatch, "已有 .catch 的应被识别为已保护（r181 实测 40）").toBeGreaterThan(20);
    // ⚠ 反假阳性锚：类型位置的 void 一个都不该被计入（首版判据不限位置时命中 896）
    expect(r.total, "首版判据把类型位置的 void 也算进来了（896 处）；收紧后应在数百量级").toBeLessThan(600);
    // 反空转锚：r180 修掉的那两处不该再出现（它们现在是 void …catch(…)）
    expect(r.hits.some((h) => h.file.includes("session-bookmarks/renderer/index.tsx") && h.expr.includes("bookmarkOrder")),
      "session-bookmarks 的顺序落盘已在 r180 加了 .catch，不该再被计入").toBe(false);
  });

  it(`① 棘轮：未保护的 void <promise> ≤ ${CEILING}（r181 实测基线；另有 ${r.unparsed} 处提取失败未计入 ⇒ 这是下界）`, () => {
    expect(r.hits.length, [
      `未保护的 void <promise> 从 ${CEILING} 涨到了 ${r.hits.length}。`,
      "      `void p` 会把**结果与错误一起丢掉**；正确形态是 `void p.catch(handler)`（丢结果、留错误）。",
      "      用户动作路径上的静默失败属 §7.6 禁止（r180 修的收藏顺序落盘就是这一类：",
      "      写失败 ⇒ 新顺序静默不落盘、重启后回退、零反馈）。",
      "      正当的发射后不管（通知 notify.show、清理 dispose、内部自保护的编排器方法）",
      "      按 r85 的先例逐轮分类入账本；新增的要么加 .catch，要么写进账本并给出理由。",
      `      ⚠ 另有 ${r.unparsed} 处表达式提取失败未计入（跨行/嵌套形态），所以本数字是**下界**。`,
      `      新增的前 10 处：${r.hits.slice(0, 10).map((h) => `${h.file}:${h.line}`).join(", ")}`,
    ].join("\n")).toBeLessThanOrEqual(CEILING);
  });

  it("② 自检：已知的正当形态确实在命中里（否则判据可能整体失效、棘轮通过得很假）", () => {
    // notify.show 是 r122 判定过的正当发射后不管（通知尽力而为）
    expect(r.hits.some((h) => h.expr.includes("notify.show")),
      "notify.show 类应当被扫到（它是这一族里最多的正当形态；扫不到说明判据在漏）").toBe(true);
    expect(r.hits.length, "命中数不该为 0").toBeGreaterThan(100);
  });
});

describe("自保护原语豁免表：豁免的前提必须持续成立（r187）", () => {
  it("① 豁免表里的每个原语，实现里**确实**兜住了错误（否则豁免就是在替裸奔打掩护）", () => {
    for (const e of SELF_PROTECTING) {
      const src = readFileSync(join(ROOT, e.impl), "utf-8");
      expect(/\.catch\s*\(|catch\s*[({]/.test(src),
        `${e.name}（${e.impl}）的实现里找不到 catch —— 它已不再自保护，` +
        `豁免必须撤销（否则所有 void ${e.name}(…) 的调用点都变成裸奔而守卫不报）。` +
        `建表理由：${e.reason}`).toBe(true);
      expect(e.reason.length, "每条豁免都要写明理由（账本纪律）").toBeGreaterThan(10);
    }
  });

  it("② 豁免确实生效：扫到的自保护调用数 > 0（否则豁免表是死的、判据可能在漏）", () => {
    const r = scan();
    expect(r.selfProtected, "自保护原语的调用点数（r187 实测应 > 0；否则豁免表是死的）").toBeGreaterThan(0);
  });
});
