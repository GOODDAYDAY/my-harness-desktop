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
// ⚠ r232 更正：上面这句"要知道它是**下界**"是 r181 当时的状态（那时 unparsed = 23）。
//   **实测 unparsed 现在是 0** ⇒ 当前这个数字就是全量、不是下界。
//   机制保留（unparsed 仍会被打印、仍会在跨行/嵌套形态出现时重新变成下界），
//   但叙述要跟着实测走——否则读的人会以为"还有一批没扫到的"而低估这个数字（§5.3 stale 立即更；
//   r231 的通则：头注里的声明有两种，量化之后才知道是真盲区还是过期描述）。
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
const CEILING = 212;   // r232 实测收紧（213 → 212：r228/r229 的改动让一处不再是未保护形态）

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

/**
 * **已确证正当**的调用点账本（r207；此前这些站点被算进"未保护"基数，污染了数字）。
 *
 * 每条都要有：① `file` + `callee`（定位到具体调用点族，不用名字全局匹配——r189 的教训：
 * 名字相同不是同一个实现）；② `evidence`（被调方兜底实现的**文件:行号**，用内容定位核对过）；
 * ③ `reason`（为什么失败可以不告诉用户）。
 *
 * ⚠ 账本最容易烂掉的方式是"建时核过一次、之后再没人核"（r187）⇒ 下面第 ③ 条测试会
 *   **回读 evidence 指向的文件**，断言那里确实还有 catch。证据消失了账本就该撤销。
 */
const LEDGER: { file: string; callee: string; evidence: string; reason: string }[] = [
  { file: "packages/react/src/widgets/file-tree.tsx", callee: "runMutation",
    evidence: "packages/react/src/widgets/file-tree.tsx",
    reason: "同文件内定义的局部函数（:246），体内 try { await fn() } catch 已兜住并播报；4 个 void runMutation(...) 调用点因此正当（r199 逐个回读核实）" },
  { file: "src/plugins/sessions/sessions-list/renderer/index.tsx", callee: "onUpdate",
    evidence: "src/plugins/sessions/sessions-list/renderer/index.tsx",
    reason: "onUpdate 的实现是同文件内的 async 回调（:618 附近），体内 try { await ctx.sessions.updateHeader } catch 已兜住 + 播报（r203/r204 补）+ reloadAfterWrite 回滚；4 个 void onUpdate(...) 因此正当（r199 核实）" },
  { file: "src/plugins/sessions/sessions-list/renderer/index.tsx", callee: "onRawPaths",
    evidence: "src/plugins/sessions/sessions-list/renderer/index.tsx",
    reason: "onRawPaths 是实现 fetchRawPaths 的 prop（:616 处 onRawPaths={fetchRawPaths}），而 fetchRawPaths（:271-276）体内 try { await ctx.sessions.rawFilePaths(...) } catch { console.error(...); return { desktop: null, kernel: null } } ⇒ **永不 reject**，所以 5 个 void onRawPaths(...).then(...) 不会漏错误；且失败路径**最终有用户反馈**——返回的 desktop 为 null 时下游 onOpenRawFile(null) 会播报 sessions.noRawFile（r191 修的）。r208 逐个回读核实。" },
  { file: "src/plugins/insight/llm-recorder/renderer/index.tsx", callee: "reload",
    evidence: "src/plugins/insight/llm-recorder/renderer/index.tsx",
    reason: "同文件内定义的 reload（r209 机械分类核实：定义体内有 catch）⇒ 它自己已兜住并处置，调用点的 void reload(...) 不会漏错误；失败时的用户可见反馈由该定义内部负责（r209 逐个回读过调用点）。" },
  { file: "src/plugins/project/git-review/renderer/index.tsx", callee: "refresh",
    evidence: "src/plugins/project/git-review/renderer/index.tsx",
    reason: "同文件内定义的 refresh（r209 机械分类核实：定义体内有 catch）⇒ 它自己已兜住并处置，调用点的 void refresh(...) 不会漏错误；失败时的用户可见反馈由该定义内部负责（r209 逐个回读过调用点）。" },
  { file: "src/plugins/manager/skill-manager/renderer/index.tsx", callee: "refresh",
    evidence: "src/plugins/manager/skill-manager/renderer/index.tsx",
    reason: "同文件内定义的 refresh（r209 机械分类核实：定义体内有 catch）⇒ 它自己已兜住并处置，调用点的 void refresh(...) 不会漏错误；失败时的用户可见反馈由该定义内部负责（r209 逐个回读过调用点）。" },
  { file: "src/plugins/manager/plugin-manager/renderer/index.tsx", callee: "refresh",
    evidence: "src/plugins/manager/plugin-manager/renderer/index.tsx",
    reason: "同文件内定义的 refresh（r209 机械分类核实：定义体内有 catch）⇒ 它自己已兜住并处置，调用点的 void refresh(...) 不会漏错误；失败时的用户可见反馈由该定义内部负责（r209 逐个回读过调用点）。" },
  { file: "src/plugins/system/keybindings/renderer/index.tsx", callee: "reload",
    evidence: "src/plugins/system/keybindings/renderer/index.tsx",
    reason: "同文件内定义的 reload（r209 机械分类核实：定义体内有 catch）⇒ 它自己已兜住并处置，调用点的 void reload(...) 不会漏错误；失败时的用户可见反馈由该定义内部负责（r209 逐个回读过调用点）。" },
  { file: "src/plugins/system/key-hints/renderer/index.tsx", callee: "reload",
    evidence: "src/plugins/system/key-hints/renderer/index.tsx",
    reason: "同文件内定义的 reload（r209 机械分类核实：定义体内有 catch）⇒ 它自己已兜住并处置，调用点的 void reload(...) 不会漏错误；失败时的用户可见反馈由该定义内部负责（r209 逐个回读过调用点）。" },
  { file: "src/plugins/sessions/sessions-list/renderer/index.tsx", callee: "refresh",
    evidence: "src/plugins/sessions/sessions-list/renderer/index.tsx",
    reason: "同文件内定义的 refresh（r209 机械分类核实：定义体内有 catch）⇒ 它自己已兜住并处置，调用点的 void refresh(...) 不会漏错误；失败时的用户可见反馈由该定义内部负责（r209 逐个回读过调用点）。" },
  { file: "packages/react/src/manager/kernel-version-page.tsx", callee: "refresh",
    evidence: "packages/react/src/manager/kernel-version-page.tsx",
    reason: "同文件内定义的 refresh（r209 机械分类核实：定义体内有 catch）⇒ 它自己已兜住并处置，调用点的 void refresh(...) 不会漏错误；失败时的用户可见反馈由该定义内部负责（r209 逐个回读过调用点）。" },
  { file: "src/plugins/system/remote-access/renderer/index.tsx", callee: "kick",
    evidence: "src/plugins/system/remote-access/renderer/index.tsx",
    reason: "定义为 `const kick = (…) => run(async () => { … })`——**包装器 run 在箭头体外面**，而 run（:159-166）自带 try { await fn() } catch (e) { setError(…) } + setBusy 收尾 ⇒ 失败既有用户可见反馈（setError 渲染成错误条）也不会卡 busy。r216 逐个回读核实。⚠ 这一条也修正了 r214 机械分类的一个局限：那版判据只在**定义体内**找 run(，认不得这种包装器在箭头体外的形态，于是把这三处误归到「无catch」。" },
  { file: "src/plugins/system/remote-access/renderer/index.tsx", callee: "kickAll",
    evidence: "src/plugins/system/remote-access/renderer/index.tsx",
    reason: "定义为 `const kickAll = (…) => run(async () => { … })`——**包装器 run 在箭头体外面**，而 run（:159-166）自带 try { await fn() } catch (e) { setError(…) } + setBusy 收尾 ⇒ 失败既有用户可见反馈（setError 渲染成错误条）也不会卡 busy。r216 逐个回读核实。⚠ 这一条也修正了 r214 机械分类的一个局限：那版判据只在**定义体内**找 run(，认不得这种包装器在箭头体外的形态，于是把这三处误归到「无catch」。" },
  { file: "src/plugins/system/remote-access/renderer/index.tsx", callee: "setPassword",
    evidence: "src/plugins/system/remote-access/renderer/index.tsx",
    reason: "定义为 `const setPassword = (…) => run(async () => { … })`——**包装器 run 在箭头体外面**，而 run（:159-166）自带 try { await fn() } catch (e) { setError(…) } + setBusy 收尾 ⇒ 失败既有用户可见反馈（setError 渲染成错误条）也不会卡 busy。r216 逐个回读核实。⚠ 这一条也修正了 r214 机械分类的一个局限：那版判据只在**定义体内**找 run(，认不得这种包装器在箭头体外的形态，于是把这三处误归到「无catch」。" },
  { file: "src/web/kernel/build-kernel.ts", callee: "onDone",
    evidence: "src/web/kernel/build-kernel.ts",
    reason: "**回调隔离**：try { onDone(r) } catch { console.error } 之后紧跟 resolveFn?.(r) 与 cleanup()——一个消费方回调抛错不该让内核安装流程断掉；安装结果本身经 resolveFn 上报，所以这里不需要用户播报（r206 核实，与 r170 的 probe4 监听器隔离同族）" },
];

interface Hit { file: string; line: number; expr: string }

function scan(): { hits: Hit[]; unparsed: number; total: number; withCatch: number; selfProtected: number; ledgered: number } {
  const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const STMT = /(?:(?<=^)|(?<=[;{}])|(?<==>\s)|(?<=\(\s)|(?<=,\s))\s*void\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:\(|\b))/g;
  const hits: Hit[] = [];
  let unparsed = 0, total = 0, withCatch = 0, selfProtected = 0, ledgered = 0;
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
      // r207：账本命中（按 文件 + 被调方叶子名 双条件，不做全局名字匹配）
      if (LEDGER.some((e) => rel === e.file && e.callee === leaf)) { ledgered++; continue; }
      hits.push({ file: rel, line: s.slice(0, m.index).split("\n").length, expr: expr.replace(/\s+/g, " ").slice(0, 90) });
    }
  }
  return { hits, unparsed, total, withCatch, selfProtected, ledgered };
}

describe("`void <promise>` 发射后不管：未保护数只许减少", () => {
  const r = scan();

  it("判据不空转：语料规模、类型位置的 void 不被计入、已保护的被正确排除", () => {
    expect(r.total, `语句位置 void 命中数（r181 实测 333）：${r.total}`).toBeGreaterThan(200);
    expect(r.withCatch, "已有 .catch 的应被识别为已保护（r181 实测 40）").toBeGreaterThan(20);
    // ⚠ 反假阳性锚：类型位置的 void 一个都不该被计入（首版判据不限位置时命中 896）
    expect(r.total, "首版判据把类型位置的 void 也算进来了（896 处）；收紧后应在数百量级").toBeLessThan(600);
    // ⚠ r216 更正：原先这里断言"session-bookmarks 的 bookmarkOrder 不该被计入"（因为 r180 给它
    //   包了 .catch）。但后来发现 ctx.config.set 在**框架层已播报**（plugin-context.ts，r82），
    //   插件那层是双重播报 ⇒ 已回退成 `void ctx.config.set(...)`，所以它**重新被计入**是正常的。
    //   反空转锚改成断言"框架层的 config.set 自保护"这件事由 unprotected-ctx-await 的账本负责，
    //   本守卫只负责"调用点自身有没有处理"（判据不变，见该账本的理由）。
    expect(r.hits.length, "命中数不该为 0（判据在扫）").toBeGreaterThan(50);
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

describe("正当账本：每条的证据必须持续成立（r207）", () => {
  it("③ 账本里每条的 evidence 文件仍存在、且里面确实还有 catch（证据消失 ⇒ 账本该撤销）", () => {
    for (const e of LEDGER) {
      const full = join(ROOT, e.evidence);
      expect(existsSync(full), `账本证据文件不存在：${e.evidence}（该条账本已失效，应删除或改判）`).toBe(true);
      const src = readFileSync(full, "utf-8");
      expect(src.includes("catch"),
        `${e.evidence} 里已找不到 catch —— 被调方不再自兜，账本理由「${e.callee}」不再成立`).toBe(true);
      expect(e.reason.length, "每条账本都要写明理由").toBeGreaterThan(20);
    }
  });

  it("④ 账本确实生效：被账本豁免的调用点数 > 0（否则账本是死的、判据可能在漏）", () => {
    const r = scan();
    expect(r.ledgered, "账本命中数（r207 实测应 > 0：runMutation 4 + onUpdate 4 + onDone 1）").toBeGreaterThan(0);
  });
});
