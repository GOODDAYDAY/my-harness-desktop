#!/usr/bin/env node
// 压缩 ↔ 回退(rewind)三层对账 e2e —— 用真实 pi 内核 + 真实模型跑通一条会话，
// 回答那个架构问题：**内核内部把上下文压缩了，壳外面的 session 和 rewind 会不会坏？**
//
// ## 为什么必须是 e2e（单测证明不了）
//
// 这条链路上有三个**各自独立演进**的存储位面，任何一份单测都只能看见其中一份：
//   ① 底层内核 session（pi 的 JSONL：~/.pi/agent/sessions/<bucket>/<lineageId>.jsonl）
//   ② 中间层中立会话（壳的真相源：~/.my-harness-desktop-dev/sessions/<ns>.{header,entries}.json）
//   ③ UI 时间线（renderer 镜像 + 分隔线渲染）
// 压缩发生在 ①（内核运行时上下文），rewind 取数于 ②（fork 前缀物化），用户看的是 ③。
// 「压缩不破坏 rewind」这句话，只有把三层放进同一次真实运行里对账才算证明。
//
// 现有单测恰恰证明不了、还会给出假绿：session-store.writethrough.test.ts:153 手搓了一条
// **顶层带 summary** 的 compaction_end 事件，而 pi 真实事件把摘要嵌在 `result.summary` 下
// （pi agent-session.ts:1849）。单测绿、真实链路断——正是本脚本要抓的形态。
//
// ## 本脚本证明的四条命题
//
//   P1 **内核压缩是 append-only**：pi 只往 JSONL 追加一条 `compaction` 条目
//      （summary / firstKeptEntryId / tokensBefore），历史 message 行一条不删、id 与顺序不变。
//   P2 **中间层不跟随压缩瘦身**：壳收到 `compactionEnd` 只**追加**一条压缩分隔线，
//      原有 user/assistant 条目全量保留（session-single-source §4.1「中立层留全量给人类看」）。
//   P3 **rewind 到压缩点之前 = 解压**：派生前缀不含压缩边界 → seed 投影全量 →
//      新内核文件带完整历史、零 compaction 条目（压缩在这次派生里被解除）。
//   P4 **rewind 到压缩点之后 = 保形 or 回落**：前缀含压缩边界 → `assembleSeedProjection`
//      有摘要则「摘要代身」、无摘要则保守全量回落。**两种形态本脚本都判得出来并明说是哪一种**，
//      不猜、不为了绿而软化断言。
//
// ## 用法
//   npm run build && node scripts/demo/compaction-rewind.e2e.mjs [--port 9371] [--keep]
//   花真实 token：4 轮极短问答（每轮「只回复一个字」）+ 1 次压缩摘要 + 2 次回退重发。
//   --keep  保留隔离 HOME（截图 + 三层原始文件）便于人工复核；**失败时总是保留**。
//
// ## 为什么要把 compaction.keepRecentTokens 调到 1
//
// pi 默认 keepRecentTokens=20000（settings-manager.ts:778），而 findCutPoint 的算法是
// 「从末尾往前累加 token，**未超预算就一路退到起点**，再回扫前导 metadata」（compaction.ts:393-423）
// —— 会话总量不足预算时 cutIndex 塌到 0 → messagesToSummarize 为空 → prepareCompaction 返回
// undefined → compact() 抛「Nothing to compact (session too small)」。
// 实测踩过：设 30 仍然抛，因为 4 条短消息合计才 ~25 token。调到 1 让切点落在最后一条，
// 前面全部可摘要。**这只是把触发条件调小，走的仍是内核真实的压缩代码路径**，不改被测逻辑。
//
// 静默纪律（CLAUDE.md §5.6）：经 lib/app.mjs 的 launchApp → quietEnv（MHD_WINDOW=hidden），
// 窗口永不 show、不抢用户焦点；断言全走 CDP 求值 + 文件读，不依赖窗口可见。
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "9371" },
    keep: { type: "boolean", default: false },
    "keep-recent-tokens": { type: "string", default: "1" }, // 见文件头「为什么调到 1」
  },
});
const CDP_PORT = Number(args.port);
const APP_PORT = 18471; // 与兄弟 e2e(18422/18426/18454)错开：assemble 读 MHD_PORT
const KEEP_RECENT_TOKENS = Number(args["keep-recent-tokens"]);

// ---------- 极短问答（省 token）----------
// 匹配一律用**完整 prompt 文本**而不是单字：压缩摘要里可能出现「甲/乙/丙」这些字
// （我们就是让摘要保留标记的），用单字判「某条在不在」会假阳性。
// 时序：甲乙丙（压缩前）→ 压缩 → 丁（压缩后）。
// 回退锚点：丁（边界之后 → P4）、乙（边界之前且**不是首条** → P3）。
//   ⚠ 不能拿甲当 P3 的锚：甲是首条，fork 的 "before" 会走「零继承前缀」的空派生分支
//   （session-store.ts:2615，retry 首条的合法形态），那条路径证不到「全量解压」。
const PROMPT_A = "只回复一个字：甲";
const PROMPT_B = "只回复一个字：乙";
const PROMPT_C = "只回复一个字：丙";
const PROMPT_D = "只回复一个字：丁";
const REWIND_AFTER = "只回复一个字：戊"; // 回退到丁（边界后）时重发的内容
const REWIND_BEFORE = "只回复一个字：己"; // 回退到乙（边界前）时重发的内容

// ---------- 断言台账：hard 立即抛（下游已无意义时），soft 记账继续（一次运行看全貌） ----------
let passed = 0;
const softFailures = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败(hard): ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function check(cond, label, detail) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); return true; }
  softFailures.push(label);
  console.log(`  ✗ ${label}${detail ? `\n      实测: ${detail}` : ""}`);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 三层读取工具 ----------
/** ① 底层内核 session：pi 的 JSONL（逐行 parse，半截行跳过——写入竞态时下一轮再读）。 */
function readKernelJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半截行 */ }
  }
  return out;
}
const kernelMessages = (es) => es.filter((e) => e.type === "message");
const kernelCompactions = (es) => es.filter((e) => e.type === "compaction");

/** ② 中间层中立会话：header/entries 拆分双文件（neutral-session-store.ts 的文件契约）。 */
function readNeutral(sessDir, ns) {
  const hp = join(sessDir, `${ns}.header.json`);
  const ep = join(sessDir, `${ns}.entries.json`);
  if (!existsSync(hp) || !existsSync(ep)) return null;
  const h = JSON.parse(readFileSync(hp, "utf-8"));
  const e = JSON.parse(readFileSync(ep, "utf-8"));
  return { ns, rootLineageId: h.rootLineageId, header: h.header ?? {}, lineages: e.lineages ?? [] };
}
const neutralEntries = (s, lid) => (s.lineages.find((l) => l.lineageId === (lid ?? s.rootLineageId))?.entries ?? []);
const isDivider = (e) => e.message?.role === "divider";
const isCompactionDivider = (e) => isDivider(e) && e.message?.kind === "compaction";
const neutralDialog = (list) => list.filter((e) => !isDivider(e));
const textOf = (m) => (typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map((c) => c?.text ?? "").join("") : "");
const hasText = (list, needle) => list.some((e) => textOf(e.message).includes(needle));

/** 扫隔离 HOME 下 pi 的会话文件（隔离区起跑是空的，扫到的一定是本次运行产生的）。 */
function listKernelSessionFiles(home) {
  const root = join(home, ".pi", "agent", "sessions");
  const out = [];
  if (!existsSync(root)) return out;
  for (const bucket of readdirSync(root)) {
    const bd = join(root, bucket);
    if (!statSync(bd).isDirectory()) continue;
    for (const f of readdirSync(bd)) if (f.endsWith(".jsonl")) out.push(join(bd, f));
  }
  return out;
}
const nsOfKernelFile = (p) => basename(p, ".jsonl");
/** root lineage 的 lineageId ≡ neutralSessionId，且路径是 lineageId 的确定性函数
 *  （piDerivedSessionPath，§12.2）→ 按 ns 反查内核文件，不用猜桶名。 */
const kernelFileOf = (home, ns) => listKernelSessionFiles(home).find((p) => nsOfKernelFile(p) === ns) ?? null;
/** 列出由 SRC 派生（fork）出来的中立会话 ns。 */
function derivedNsOf(sessDir, srcNs, exclude = []) {
  for (const f of readdirSync(sessDir).filter((x) => x.endsWith(".header.json"))) {
    const ns = f.replace(/\.header\.json$/, "");
    if (ns === srcNs || exclude.includes(ns)) continue;
    const s = readNeutral(sessDir, ns);
    const d = s?.header?.derivedFrom;
    if (d?.kind === "fork" && d.sourceNeutralSessionId === srcNs) return ns;
  }
  return null;
}

/** 事件驱动等待（不赌固定 sleep）：fn 返回真值即命中并原样返回，falsy 则继续轮询。
 *  ⚠ 返回值可以是字符串（ns 就是字符串）——早期版本把「字符串返回」当诊断信息，
 *  于是等 ns 的那两处永远命中不了（实测：派生会话早已落盘，却报等待超时）。
 *  诊断信息只从抛错里取。 */
async function waitFor(fn, { timeout = 60000, interval = 400, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (err) { lastErr = err.message; }
    if (Date.now() > deadline) {
      throw new Error(`等待超时(${timeout}ms): ${label}${lastErr ? ` — 最后一次抛错: ${lastErr}` : ""}`);
    }
    await sleep(interval);
  }
}

// ---------- UI 驱动（React 受控 textarea 写入 + 可信点击） ----------
const setComposer = (page, text, sel = "[data-timeline-composer]") => page.evaluate((s, t) => {
  const ta = document.querySelector(s);
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, t);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  return true;
}, sel, text);

const clickSend = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    (x.getAttribute("aria-label") || x.title || "").includes("发送") && x.getBoundingClientRect().width > 0);
  if (!b) return false;
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
});

/** 等回合收敛：先等「停止」出现（回合真起跑），再等它消失（收敛）。两段都事件驱动。 */
async function settle(page, timeoutMs = 120000) {
  const appeared = await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).then(() => true).catch(() => false);
  if (appeared) {
    await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: timeoutMs, polling: 500 });
  }
}

async function sendAndWait(page, text) {
  if (!(await setComposer(page, text))) throw new Error("composer 不可用");
  if (!(await clickSend(page))) throw new Error("发送按钮不可用");
  await settle(page);
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 15000 }).catch(() => {});
}

/** 时间线上当前渲染的消息行文本（③ UI 层的统一读口）。 */
const uiRows = (page) => page.evaluate(() =>
  [...document.querySelectorAll("[data-message-id]")].map((r) => (r.textContent || "")));

/** 在某条 user 消息行上执行真实 rewind：hover → 点「回退」→ 内联框写入 → 提交。
 *  锚点全是稳定 data-*（data-message-id / data-rewind-inline），不按 class/文案层级猜。 */
async function rewindAt(page, userPromptText, newText) {
  const box = await page.evaluate((marker) => {
    const rows = [...document.querySelectorAll("[data-message-id]")];
    const row = rows.find((r) => (r.textContent || "").includes(marker));
    if (!row) return { err: `找不到消息行: ${marker}`, rows: rows.map((r) => (r.textContent || "").trim().slice(0, 24)) };
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, userPromptText);
  if (box.err) throw new Error(`rewind 定位失败: ${box.err}（现有行: ${JSON.stringify(box.rows)}）`);
  await page.mouse.move(box.x, box.y); // 可信 hover：动作按钮淡入
  await sleep(700);
  const clicked = await page.evaluate((marker) => {
    const rows = [...document.querySelectorAll("[data-message-id]")];
    const row = rows.find((r) => (r.textContent || "").includes(marker));
    const btns = [...row.querySelectorAll("button")];
    const btn = btns.find((b) => (b.title || b.getAttribute("aria-label") || "").includes("回退"));
    if (!btn) return { ok: false, titles: btns.map((b) => b.title || b.getAttribute("aria-label")) };
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { ok: true };
  }, userPromptText);
  if (!clicked.ok) throw new Error(`未找到「回退」按钮（该行按钮: ${JSON.stringify(clicked.titles)}）`);
  await page.waitForSelector("[data-rewind-inline] textarea", { timeout: 10000 });
  await setComposer(page, newText, "[data-rewind-inline] textarea");
  await page.keyboard.press("Enter");
  // 兜底：Enter 被 IME/焦点吃掉时点内联框自己的发送按钮（不赌单一输入路径）
  const gone = await page.waitForFunction(() => !document.querySelector("[data-rewind-inline]"), { timeout: 8000, polling: 300 })
    .then(() => true).catch(() => false);
  if (!gone) {
    await page.evaluate(() => {
      const inline = document.querySelector("[data-rewind-inline]");
      const b = inline && [...inline.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || x.title || "").includes("发送"));
      if (b) b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForFunction(() => !document.querySelector("[data-rewind-inline]"), { timeout: 10000, polling: 300 });
  }
  await settle(page).catch(() => {});
}

/** 从侧栏打开指定会话（可信点击：合成事件对会话行实测翻车过，见 fork.e2e.mjs 注释）。 */
async function openSessionRow(page, sessionPath) {
  const at = await page.evaluate((p) => {
    const rows = [...document.querySelectorAll("[data-session-path]")];
    const row = rows.find((r) => r.getAttribute("data-session-path") === p);
    if (!row) return { err: "侧栏找不到该会话行", paths: rows.map((r) => r.getAttribute("data-session-path")) };
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sessionPath);
  if (at.err) throw new Error(`${at.err}（现有: ${JSON.stringify(at.paths)}）`);
  await page.mouse.click(at.x, at.y);
}

// ---------- 环境准备 ----------
if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物，先跑: npm run build");
  process.exit(1);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// 把 pi 的压缩阈值调到极小（见文件头）——settings.json 是**拷贝**进隔离区的，写它不碰真实 profile。
const piSettingsPath = join(home, ".pi", "agent", "settings.json");
{
  const cur = existsSync(piSettingsPath) ? JSON.parse(readFileSync(piSettingsPath, "utf-8")) : {};
  cur.compaction = { ...(cur.compaction ?? {}), enabled: true, keepRecentTokens: KEEP_RECENT_TOKENS };
  writeFileSync(piSettingsPath, JSON.stringify(cur, null, 2), "utf-8");
}
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
const SESS_DIR = join(home, ".my-harness-desktop-dev", "sessions");
const SHOTS = join(runRoot, "shots");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => {});

console.log(`隔离 HOME: ${home}`);
console.log(`真实 pi 内核 + 真实模型；compaction.keepRecentTokens=${KEEP_RECENT_TOKENS}（小会话也能触发真实压缩）`);
console.log(`4 轮极短问答 + 1 次压缩 + 2 次回退\n`);

const app = await launchApp({ appDir: ROOT, port: CDP_PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("console", (m) => consoleTail.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleTail.push(`[pageerror] ${e.message}`));

let failed = false;
try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  ok(true, "① 应用启动、composer 可用（窗口 hidden，未抢用户焦点）");

  // ===== 第 1 段：压缩前的真实历史（三轮） =====
  console.log("\n[1] 建立真实历史（甲、乙、丙 三轮问答）");
  for (const p of [PROMPT_A, PROMPT_B, PROMPT_C]) await sendAndWait(page, p);

  const kernelFiles = listKernelSessionFiles(home);
  ok(kernelFiles.length === 1, `② 底层内核 session 文件已生成（实测 ${kernelFiles.length} 个）`);
  const srcKernelFile = kernelFiles[0];
  const SRC_NS = nsOfKernelFile(srcKernelFile);
  console.log(`      ns       = ${SRC_NS}`);
  console.log(`      内核文件 = …/${basename(dirname(srcKernelFile)).slice(0, 40)}…/${basename(srcKernelFile)}`);

  const kernelBefore = readKernelJsonl(srcKernelFile);
  const msgIdsBefore = kernelMessages(kernelBefore).map((e) => e.id);
  const neutralBefore = readNeutral(SESS_DIR, SRC_NS);
  ok(!!neutralBefore, "③ 中间层中立会话已落盘（header + entries 双文件）");
  const entriesBefore = neutralEntries(neutralBefore);
  const idsBefore = entriesBefore.map((e) => e.neutralEntryId);
  const dialogBefore = neutralDialog(entriesBefore);
  check(msgIdsBefore.length >= 6, `④ [底层] ≥6 条 message（三轮 × user/assistant；实测 ${msgIdsBefore.length}）`);
  check(dialogBefore.length >= 6, `⑤ [中间层] ≥6 条对话条目（实测 ${dialogBefore.length}）`);
  check([PROMPT_A, PROMPT_B, PROMPT_C].every((p) => hasText(entriesBefore, p)),
    "⑥ [中间层] 三轮内容都对得上真实问答（甲乙丙的 user 条目都在）");
  await shot(page, "1-history");

  // ===== 第 2 段：触发真实压缩（renderer → IPC session:compact → pi `compact` RPC）=====
  console.log("\n[2] 触发内核压缩（window.kernel.sessions.compact）");
  const compactErr = await page.evaluate(async () => {
    try { await window.kernel.sessions.compact("请保留甲、乙、丙三个标记"); return null; }
    catch (e) { return String(e?.message ?? e); }
  });
  ok(!compactErr, `⑦ compact() 成功返回${compactErr ? `（实测报错: ${compactErr}）` : ""}`);

  const kernelAfter = await waitFor(() => {
    const es = readKernelJsonl(srcKernelFile);
    return kernelCompactions(es).length > 0 ? es : null;
  }, { timeout: 120000, label: "底层内核 JSONL 出现 compaction 条目" });
  const neutralAfter = await waitFor(() => {
    const s = readNeutral(SESS_DIR, SRC_NS);
    return s && neutralEntries(s).some(isCompactionDivider) ? s : null;
  }, { timeout: 30000, label: "中间层出现压缩分隔线" });
  ok(true, "⑧ compactionEnd 到达：底层落压缩条目、中间层落压缩分隔线");
  await shot(page, "2-after-compaction");

  // ===== 第 3 段：三层对账（本脚本的核心）=====
  console.log("\n[3] 三层对账（压缩发生后，源会话）");

  // —— ① 底层内核 session：P1 append-only ——
  const comp = kernelCompactions(kernelAfter)[0];
  check(typeof comp.summary === "string" && comp.summary.length > 0,
    "⑨ [底层] compaction 条目带 summary（内核真的生成了摘要）",
    `summary=${JSON.stringify(String(comp.summary ?? "").slice(0, 60))}`);
  check(typeof comp.firstKeptEntryId === "string" && comp.firstKeptEntryId.length > 0,
    "⑩ [底层] compaction 条目带 firstKeptEntryId（运行时上下文的保留起点）",
    `firstKeptEntryId=${JSON.stringify(comp.firstKeptEntryId)}`);
  check(typeof comp.tokensBefore === "number",
    `⑪ [底层] compaction 条目带 tokensBefore（实测 ${JSON.stringify(comp.tokensBefore)}）`);
  const msgIdsAfter = kernelMessages(kernelAfter).map((e) => e.id);
  check(msgIdsAfter.length === msgIdsBefore.length && JSON.stringify(msgIdsAfter) === JSON.stringify(msgIdsBefore),
    `⑫ [底层·P1] 压缩是 append-only：message 行一条不删、id 与顺序不变（${msgIdsBefore.length} → ${msgIdsAfter.length}）`,
    `丢失/变动: ${JSON.stringify(msgIdsBefore.filter((id) => !msgIdsAfter.includes(id)))}`);
  check(kernelCompactions(kernelAfter).length === 1,
    `⑬ [底层] 恰好追加 1 条 compaction（实测 ${kernelCompactions(kernelAfter).length}；自动压缩未干扰）`);

  // —— ② 中间层：P2 全量保留 + 只追加一条分隔线 ——
  const entriesAfter = neutralEntries(neutralAfter);
  const idsAfter = entriesAfter.map((e) => e.neutralEntryId);
  check(JSON.stringify(idsAfter.slice(0, idsBefore.length)) === JSON.stringify(idsBefore),
    `⑭ [中间层·P2] 原有条目一条不少、顺序不变（${idsBefore.length} → ${idsAfter.length}）`,
    `丢失: ${JSON.stringify(idsBefore.filter((id) => !idsAfter.includes(id)))}`);
  const dividers = entriesAfter.filter(isCompactionDivider);
  check(dividers.length === 1, `⑮ [中间层] 恰好追加 1 条压缩分隔线（实测 ${dividers.length}）`);
  check(neutralDialog(entriesAfter).length === dialogBefore.length,
    `⑯ [中间层·P2] 对话条目数不变（${dialogBefore.length} → ${neutralDialog(entriesAfter).length}）：压缩没让外部历史瘦身`);

  // —— P4 前置：分隔线到底带不带摘要？（决定 seed 投影走「摘要代身」还是「全量回落」）——
  const divMsg = dividers[0]?.message ?? {};
  const divSummary = typeof divMsg.detail === "string" ? divMsg.detail : null;
  const divTokens = divMsg.i18nArgs?.tokens ?? null;
  const summaryCarried = check(!!divSummary,
    "⑰ [中间层·P4 前置] 压缩分隔线带摘要 detail（seed 投影才能「摘要代身」）",
    `detail=${JSON.stringify(divSummary)}；i18nArgs=${JSON.stringify(divMsg.i18nArgs)}；`
    + `而底层内核侧 summary 长度=${String(comp.summary ?? "").length} → 摘要在内核里有、没传到中间层`);
  check(!!divTokens, "⑱ [中间层] 压缩分隔线带 tokens（UI 才能显示「上下文已压缩(N tokens)」）",
    `i18nArgs=${JSON.stringify(divMsg.i18nArgs)}`);

  // —— ③ UI 层 ——
  const rowsAfterCompaction = await uiRows(page);
  const ui = {
    rowCount: rowsAfterCompaction.length,
    marks: [PROMPT_A, PROMPT_B, PROMPT_C].map((p) => [p.slice(-1), rowsAfterCompaction.some((t) => t.includes(p))]),
  };
  const uiLine = await page.evaluate(() => ({
    has: document.body.innerText.includes("上下文已压缩"),
    text: (document.body.innerText.match(/上下文已压缩[^\n]*/) ?? [null])[0],
  }));
  check(uiLine.has, "⑲ [UI] 时间线渲染出压缩分隔线", `实测文案: ${JSON.stringify(uiLine.text)}`);
  check(ui.marks.every(([, v]) => v),
    "⑳ [UI·P2] 压缩后历史消息在时间线上仍全部可见（外部 session 没被压掉）",
    `${JSON.stringify(Object.fromEntries(ui.marks))}（行数 ${ui.rowCount}）`);

  // ===== 第 4 段：压缩点之后 rewind（P4）=====
  console.log("\n[4] rewind 到压缩点**之后**（先发丁，再回退到丁）");
  await sendAndWait(page, PROMPT_D);
  const entriesWithD = neutralEntries(readNeutral(SESS_DIR, SRC_NS));
  check(hasText(entriesWithD, PROMPT_D), "㉑ 压缩后继续对话正常（丁 落中间层）：压缩没把会话写坏");
  const divIdx = entriesWithD.findIndex(isCompactionDivider);
  const dIdx = entriesWithD.findIndex((e) => textOf(e.message).includes(PROMPT_D));
  ok(divIdx >= 0 && dIdx > divIdx, `㉒ 丁 确实在压缩边界之后（divider@${divIdx} < 丁@${dIdx}）`);
  const srcMsgCountAfterD = kernelMessages(readKernelJsonl(srcKernelFile)).length;
  await shot(page, "3-before-rewind-after");

  const srcRowPaths = await page.evaluate(() =>
    [...document.querySelectorAll("[data-session-path]")].map((r) => r.getAttribute("data-session-path")));
  await rewindAt(page, PROMPT_D, REWIND_AFTER);

  const derivedAfterNs = await waitFor(() => derivedNsOf(SESS_DIR, SRC_NS),
    { timeout: 30000, label: "派生会话（回退到压缩点之后）落中间层" });
  ok(true, `㉓ [中间层·P4] rewind 派生出新会话 ns=${derivedAfterNs.slice(0, 8)}…（derivedFrom.kind=fork）`);

  const dAfterFile = await waitFor(() => {
    const hit = kernelFileOf(home, derivedAfterNs);
    return hit && kernelMessages(readKernelJsonl(hit)).length > 0 ? hit : null;
  }, { timeout: 60000, label: "派生会话（边界后）的底层内核文件物化" });
  const dAfterKernel = readKernelJsonl(dAfterFile);
  const dAfterMsgs = kernelMessages(dAfterKernel);
  const dAfterTexts = dAfterMsgs.map((e) => textOf(e.message));
  const hasSummaryProxy = dAfterTexts.some((t) => t.includes("[此前会话的压缩摘要]"));
  const hasOldHistory = dAfterTexts.some((t) => t.includes(PROMPT_A)) && dAfterTexts.some((t) => t.includes(PROMPT_B));
  console.log(`      [底层] 派生文件 ${basename(dAfterFile)}：${dAfterMsgs.length} 条 message、`
    + `${kernelCompactions(dAfterKernel).length} 条 compaction`);
  console.log(`      [底层] 摘要代身=${hasSummaryProxy}；边界前历史被回灌=${hasOldHistory}`);
  if (summaryCarried) {
    check(hasSummaryProxy && !hasOldHistory,
      "㉔ [底层·P4] 有摘要 → seed 投影「摘要代身」：新内核只吃摘要，压缩形态被保住",
      `texts=${JSON.stringify(dAfterTexts.map((t) => t.slice(0, 30)))}`);
  } else {
    check(hasOldHistory,
      "㉔ [底层·P4] 无摘要 → seed 投影**保守全量回落**（宁多灌不丢语义）：边界前的历史被完整回灌新内核",
      `texts=${JSON.stringify(dAfterTexts.map((t) => t.slice(0, 30)))}`);
    console.log("      ↳ 这正是 ⑰ 的下游后果：摘要没传到中间层，「摘要代身」这条设计路径在生产里走不到。");
  }
  check(kernelCompactions(dAfterKernel).length === 0,
    "㉕ [底层] 派生会话的内核文件里没有 compaction 条目（派生=重新物化，不是复制压缩状态）");

  const srcNeutralNow = readNeutral(SESS_DIR, SRC_NS);
  const srcKernelNow = readKernelJsonl(srcKernelFile);
  check(neutralEntries(srcNeutralNow).some(isCompactionDivider) && hasText(neutralEntries(srcNeutralNow), PROMPT_D),
    "㉖ [中间层] 源会话未被 rewind 改动（压缩分隔线、丁 都还在）");
  check(kernelCompactions(srcKernelNow).length === 1 && kernelMessages(srcKernelNow).length === srcMsgCountAfterD,
    `㉗ [底层] 源会话内核文件未被 rewind 改动（message ${kernelMessages(srcKernelNow).length} 条 = 回退前 ${srcMsgCountAfterD} 条、compaction 仍 1 条）`);
  await shot(page, "4-rewind-after");

  // ===== 第 5 段：压缩点之前 rewind（P3 解压）=====
  console.log("\n[5] 切回源会话 → rewind 到压缩点**之前**（回退到乙）");
  const srcRowPath = srcRowPaths.find((p) => p && p.endsWith(`${SRC_NS}.jsonl`)) ?? srcKernelFile;
  await openSessionRow(page, srcRowPath);
  await waitFor(() => page.evaluate((m) =>
    [...document.querySelectorAll("[data-message-id]")].some((r) => (r.textContent || "").includes(m)), PROMPT_B),
  { timeout: 25000, label: "源会话时间线重新渲染出 乙" });
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 15000 }).catch(() => {});
  const entriesSrcNow = neutralEntries(readNeutral(SESS_DIR, SRC_NS));
  const bIdx = entriesSrcNow.findIndex((e) => textOf(e.message).includes(PROMPT_B));
  const divIdx2 = entriesSrcNow.findIndex(isCompactionDivider);
  ok(bIdx > 0 && bIdx < divIdx2, `㉘ 乙 在压缩边界之前、且不是首条（乙@${bIdx}，divider@${divIdx2}）`);

  await rewindAt(page, PROMPT_B, REWIND_BEFORE);
  const derivedBeforeNs = await waitFor(() => derivedNsOf(SESS_DIR, SRC_NS, [derivedAfterNs]),
    { timeout: 30000, label: "派生会话（回退到压缩点之前）落中间层" });
  const dBeforeEntries = neutralEntries(readNeutral(SESS_DIR, derivedBeforeNs));
  check(hasText(dBeforeEntries, PROMPT_A),
    "㉙ [中间层·P3] 派生会话带着压缩点之前的历史（甲在）：rewind 取数于中间层全量，不受内核压缩影响");
  check(!dBeforeEntries.some(isCompactionDivider),
    "㉚ [中间层·P3] 派生会话**不含**压缩分隔线（切点在边界之前 → 压缩在这次派生里被解除）");
  check(!hasText(dBeforeEntries, PROMPT_C) && !hasText(dBeforeEntries, PROMPT_D),
    "㉛ [中间层] 边界之后的 丙/丁 没被卷进来（fork 前缀截断正确，不多带）");

  const dBeforeFile = await waitFor(() => {
    const hit = kernelFileOf(home, derivedBeforeNs);
    return hit && kernelMessages(readKernelJsonl(hit)).length > 0 ? hit : null;
  }, { timeout: 60000, label: "派生会话（边界前）的底层内核文件物化" });
  const dBeforeKernel = readKernelJsonl(dBeforeFile);
  const dBeforeMsgs = kernelMessages(dBeforeKernel);
  const dbTexts = dBeforeMsgs.map((e) => textOf(e.message));
  console.log(`      [底层] 派生文件 ${basename(dBeforeFile)}：${dBeforeMsgs.length} 条 message、`
    + `${kernelCompactions(dBeforeKernel).length} 条 compaction；文本=${JSON.stringify(dbTexts.map((t) => t.slice(0, 16)))}`);
  check(dbTexts.some((t) => t.includes(PROMPT_A)) && !dbTexts.some((t) => t.includes(PROMPT_C)),
    "㉜ [底层·P3] 新内核文件 = 压缩点之前的全量历史（含甲、不含丙）→ 冷起后上下文完整回灌");
  check(kernelCompactions(dBeforeKernel).length === 0,
    "㉝ [底层·P3] 新内核文件零 compaction 条目：pi 读回的是全量历史，不是摘要");
  check(kernelCompactions(readKernelJsonl(srcKernelFile)).length === 1,
    "㉞ [底层] 源会话内核文件仍保有自己的 compaction 条目（派生不动源）");

  const rowsFinal = await uiRows(page);
  const ui2 = {
    rowCount: rowsFinal.length,
    hasA: rowsFinal.some((t) => t.includes(PROMPT_A)),
    hasNew: rowsFinal.some((t) => t.includes(REWIND_BEFORE)),
  };
  check(ui2.hasA && ui2.hasNew, "㉟ [UI·P3] 回退后的时间线：压缩点之前的历史 + 新发那条都在",
    `甲=${ui2.hasA} 己=${ui2.hasNew}（行数 ${ui2.rowCount}）`);
  await shot(page, "5-rewind-before");

  const errs = consoleTail.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"));
  check(errs.length === 0, `㊱ 页面零报错（实测 ${errs.length} 条${errs[0] ? `: ${errs[0].slice(0, 140)}` : ""}）`);

  // ---------- 三层对账总表（本脚本的"说明"产出）----------
  const cell = (s, w) => String(s).padEnd(Math.max(0, w - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)), " ");
  console.log("\n===== 三层对账总表 =====");
  console.log(`  ${cell("位面", 18)}| ${cell("源会话（压缩后）", 30)}| ${cell("派生A（锚在边界后）", 26)}| 派生B（锚在边界前）`);
  console.log(`  ${cell("① 底层内核 JSONL", 18)}| ${cell(`${msgIdsAfter.length} msg + 1 compaction`, 30)}| `
    + `${cell(`${dAfterMsgs.length} msg + 0 compaction`, 26)}| ${dBeforeMsgs.length} msg + 0 compaction`);
  console.log(`  ${cell("② 中间层中立会话", 18)}| ${cell(`${entriesAfter.length} 条（含 1 分隔线，全量）`, 30)}| `
    + `${cell(`${neutralEntries(readNeutral(SESS_DIR, derivedAfterNs)).length} 条（含分隔线）`, 26)}| ${dBeforeEntries.length} 条（无分隔线，全量）`);
  console.log(`  ${cell("③ UI 时间线", 18)}| ${cell(`${ui.rowCount} 行 + 压缩分隔线`, 30)}| `
    + `${cell("见截图 4-rewind-after", 26)}| ${ui2.rowCount} 行，历史全在`);
  console.log("\n  结论：压缩只改「内核运行时上下文」这一个位面；② ③ 全量保留，rewind 取数于 ② →");
  console.log(`        ${summaryCarried
    ? "边界后保形（摘要代身）、边界前解压（全量回灌）。"
    : "两个方向都把边界前的历史全量回灌新内核（摘要未传到中间层 → 走了保守回落）。"}`);

  console.log(`\n===== 断言: ${passed} 通过 / ${softFailures.length} 失败 =====`);
  for (const f of softFailures) console.log(`  ✗ ${f}`);
  console.log(`截图: ${SHOTS}`);
  failed = softFailures.length > 0;
} catch (e) {
  failed = true;
  console.error(`\n❌ FAIL: ${e.message}`);
  console.error("控制台尾部:\n" + consoleTail.slice(-15).join("\n"));
  await shot(page, "FAIL").catch(() => {});
} finally {
  await killApp(app);
  if (failed || args.keep) {
    console.log(`\n诊断现场已保留: ${runRoot}`);
    console.log(`  ② 中间层:   ${SESS_DIR}`);
    console.log(`  ① 底层内核: ${join(home, ".pi", "agent", "sessions")}`);
    console.log(`  ③ 截图:     ${SHOTS}`);
  }
  process.exit(failed ? 1 : 0);
}
