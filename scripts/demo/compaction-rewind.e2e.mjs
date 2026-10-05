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
// 压缩发生在 ①（准确说是 pi 进程内的运行时上下文，① 是它的落盘载体），rewind 取数于 ②，
// 用户看的是 ③。「压缩不破坏 rewind」这句话，只有把三层放进同一次真实运行里对账才算证明。
//
// 既有单测恰恰证明不了、还会给出假绿：session-store.writethrough.test.ts 曾手搓**顶层带
// summary** 的 compaction_end 事件，而 pi 真实事件把摘要嵌在 `result.summary` 下
// （pi agent-session.ts:1849）——单测绿、真实链路断。这条剧本抓到了它（见「分隔线带摘要 detail」那两条断言）。
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
// 姊妹剧本：compaction-overflow-rewind.e2e.mjs（中间层本身**超过上下文窗口**时 rewind 回超限区间，
// 以及失败压缩会不会在中立层留下假边界）。两者共用 lib/session-layers.mjs 的三层读取与 UI 驱动原语。
//
// ## 用法
//   npm run e2e:compaction-rewind          （= node scripts/demo/compaction-rewind.e2e.mjs）
//   需要先 npm run build；花真实 token：4 轮极短问答 + 1 次压缩摘要 + 2 次回退重发。
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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import {
  makeLedger, waitFor,
  readKernelJsonl, kernelMessages, kernelCompactions,
  listKernelSessionFiles, nsOfKernelFile, kernelFileOf,
  readNeutral, neutralEntries, isCompactionDivider, neutralDialog, textOf, hasText, derivedNsOf,
  patchPiSettings,
  sendAndWait, uiRows, rewindAt, openSessionRow, callCompact,
} from "./lib/session-layers.mjs";

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
patchPiSettings(home, { compaction: { enabled: true, keepRecentTokens: KEEP_RECENT_TOKENS } });
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
const SESS_DIR = join(home, ".my-harness-desktop-dev", "sessions");
const SHOTS = join(runRoot, "shots");
mkdirSync(SHOTS, { recursive: true });

const L = makeLedger();
const { ok, check, note } = L;
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
  ok(true, "应用启动、composer 可用（窗口 hidden，未抢用户焦点）");

  // ===== 第 1 段：真实历史（压缩前三轮） =====
  console.log("\n[1] 建立真实历史（甲、乙、丙 三轮问答）");
  for (const p of [PROMPT_A, PROMPT_B, PROMPT_C]) {
    await sendAndWait(page, p);
    await waitForDomIdle(page, { quietMs: 600, timeoutMs: 12000 }).catch(() => {});
  }

  const kernelFiles = listKernelSessionFiles(home);
  ok(kernelFiles.length === 1, `底层内核 session 文件已生成（实测 ${kernelFiles.length} 个）`);
  const srcKernelFile = kernelFiles[0];
  const SRC_NS = nsOfKernelFile(srcKernelFile); // root lineage 的 lineageId ≡ neutralSessionId → 文件名即 ns
  note(`ns       = ${SRC_NS}`);
  note(`内核文件 = …/${basename(dirname(srcKernelFile)).slice(0, 40)}…/${basename(srcKernelFile)}`);

  const kernelBefore = readKernelJsonl(srcKernelFile);
  const msgIdsBefore = kernelMessages(kernelBefore).map((e) => e.id);
  const neutralBefore = readNeutral(SESS_DIR, SRC_NS);
  ok(!!neutralBefore, "中间层中立会话已落盘（header + entries 双文件）");
  const entriesBefore = neutralEntries(neutralBefore);
  const idsBefore = entriesBefore.map((e) => e.neutralEntryId);
  const dialogBefore = neutralDialog(entriesBefore);
  check(msgIdsBefore.length >= 6, `[底层] ≥6 条 message（三轮 × user/assistant；实测 ${msgIdsBefore.length}）`);
  check(dialogBefore.length >= 6, `[中间层] ≥6 条对话条目（实测 ${dialogBefore.length}）`);
  check([PROMPT_A, PROMPT_B, PROMPT_C].every((p) => hasText(entriesBefore, p)),
    "[中间层] 三轮内容都对得上真实问答（甲乙丙的 user 条目都在）");
  await shot(page, "1-history");

  // ===== 第 2 段：触发真实压缩（renderer → IPC session:compact → pi `compact` RPC）=====
  console.log("\n[2] 触发内核压缩（window.kernel.sessions.compact）");
  const compactErr = await callCompact(page, "请保留甲、乙、丙三个标记");
  ok(!compactErr, `compact() 成功返回${compactErr ? `（实测报错: ${compactErr}）` : ""}`);

  const kernelAfter = await waitFor(() => {
    const es = readKernelJsonl(srcKernelFile);
    return kernelCompactions(es).length > 0 ? es : null;
  }, { timeout: 120000, label: "底层内核 JSONL 出现 compaction 条目" });
  const neutralAfter = await waitFor(() => {
    const s = readNeutral(SESS_DIR, SRC_NS);
    return s && neutralEntries(s).some(isCompactionDivider) ? s : null;
  }, { timeout: 30000, label: "中间层出现压缩分隔线" });
  ok(true, "compactionEnd 到达：底层落压缩条目、中间层落压缩分隔线");
  await shot(page, "2-after-compaction");

  // ===== 第 3 段：三层对账（本脚本的核心）=====
  console.log("\n[3] 三层对账（压缩发生后，源会话）");

  // —— ① 底层内核 session：P1 append-only ——
  const comp = kernelCompactions(kernelAfter)[0];
  check(typeof comp.summary === "string" && comp.summary.length > 0,
    "[底层] compaction 条目带 summary（内核真的生成了摘要）",
    `summary=${JSON.stringify(String(comp.summary ?? "").slice(0, 60))}`);
  check(typeof comp.firstKeptEntryId === "string" && comp.firstKeptEntryId.length > 0,
    "[底层] compaction 条目带 firstKeptEntryId（运行时上下文的保留起点）",
    `firstKeptEntryId=${JSON.stringify(comp.firstKeptEntryId)}`);
  check(typeof comp.tokensBefore === "number",
    `[底层] compaction 条目带 tokensBefore（实测 ${JSON.stringify(comp.tokensBefore)}）`);
  const msgIdsAfter = kernelMessages(kernelAfter).map((e) => e.id);
  check(msgIdsAfter.length === msgIdsBefore.length && JSON.stringify(msgIdsAfter) === JSON.stringify(msgIdsBefore),
    `[底层·P1] 压缩是 append-only：message 行一条不删、id 与顺序不变（${msgIdsBefore.length} → ${msgIdsAfter.length}）`,
    `丢失/变动: ${JSON.stringify(msgIdsBefore.filter((id) => !msgIdsAfter.includes(id)))}`);
  check(kernelCompactions(kernelAfter).length === 1,
    `[底层] 恰好追加 1 条 compaction（实测 ${kernelCompactions(kernelAfter).length}；自动压缩未干扰）`);

  // —— ② 中间层：P2 全量保留 + 只追加一条分隔线 ——
  const entriesAfter = neutralEntries(neutralAfter);
  const idsAfter = entriesAfter.map((e) => e.neutralEntryId);
  check(JSON.stringify(idsAfter.slice(0, idsBefore.length)) === JSON.stringify(idsBefore),
    `[中间层·P2] 原有条目一条不少、顺序不变（${idsBefore.length} → ${idsAfter.length}）`,
    `丢失: ${JSON.stringify(idsBefore.filter((id) => !idsAfter.includes(id)))}`);
  const dividers = entriesAfter.filter(isCompactionDivider);
  check(dividers.length === 1, `[中间层] 恰好追加 1 条压缩分隔线（实测 ${dividers.length}）`);
  check(neutralDialog(entriesAfter).length === dialogBefore.length,
    `[中间层·P2] 对话条目数不变（${dialogBefore.length} → ${neutralDialog(entriesAfter).length}）：压缩没让外部历史瘦身`);

  // —— P4 前置：分隔线到底带不带摘要？（决定 seed 投影走「摘要代身」还是「全量回落」）——
  const divMsg = dividers[0]?.message ?? {};
  const divSummary = typeof divMsg.detail === "string" ? divMsg.detail : null;
  const divTokens = divMsg.i18nArgs?.tokens ?? null;
  const summaryCarried = check(!!divSummary,
    "[中间层·P4 前置] 压缩分隔线带摘要 detail（seed 投影才能「摘要代身」）",
    `detail=${JSON.stringify(divSummary)}；i18nArgs=${JSON.stringify(divMsg.i18nArgs)}；`
    + `而底层内核侧 summary 长度=${String(comp.summary ?? "").length} → 摘要在内核里有、没传到中间层`);
  check(!!divTokens, "[中间层] 压缩分隔线带 tokens（UI 才能显示「上下文已压缩(N tokens)」）",
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
  check(uiLine.has, "[UI] 时间线渲染出压缩分隔线", `实测文案: ${JSON.stringify(uiLine.text)}`);
  check(ui.marks.every(([, v]) => v),
    "[UI·P2] 压缩后历史消息在时间线上仍全部可见（外部 session 没被压掉）",
    `${JSON.stringify(Object.fromEntries(ui.marks))}（行数 ${ui.rowCount}）`);

  // ===== 第 4 段：压缩点之后 rewind（P4）=====
  console.log("\n[4] rewind 到压缩点**之后**（先发丁，再回退到丁）");
  await sendAndWait(page, PROMPT_D);
  const entriesWithD = neutralEntries(readNeutral(SESS_DIR, SRC_NS));
  check(hasText(entriesWithD, PROMPT_D), "压缩后继续对话正常（丁 落中间层）：压缩没把会话写坏");
  const divIdx = entriesWithD.findIndex(isCompactionDivider);
  const dIdx = entriesWithD.findIndex((e) => textOf(e.message).includes(PROMPT_D));
  ok(divIdx >= 0 && dIdx > divIdx, `丁 确实在压缩边界之后（divider@${divIdx} < 丁@${dIdx}）`);
  const srcMsgCountAfterD = kernelMessages(readKernelJsonl(srcKernelFile)).length;
  await shot(page, "3-before-rewind-after");

  const srcRowPaths = await page.evaluate(() =>
    [...document.querySelectorAll("[data-session-path]")].map((r) => r.getAttribute("data-session-path")));
  await rewindAt(page, PROMPT_D, REWIND_AFTER);

  const derivedAfterNs = await waitFor(() => derivedNsOf(SESS_DIR, SRC_NS),
    { timeout: 30000, label: "派生会话（回退到压缩点之后）落中间层" });
  ok(true, `[中间层·P4] rewind 派生出新会话 ns=${derivedAfterNs.slice(0, 8)}…（derivedFrom.kind=fork）`);

  const dAfterFile = await waitFor(() => {
    const hit = kernelFileOf(home, derivedAfterNs);
    return hit && kernelMessages(readKernelJsonl(hit)).length > 0 ? hit : null;
  }, { timeout: 90000, label: "派生会话（边界后）的底层内核文件物化" });
  const dAfterKernel = readKernelJsonl(dAfterFile);
  const dAfterMsgs = kernelMessages(dAfterKernel);
  const dAfterTexts = dAfterMsgs.map((e) => textOf(e.message));
  const hasSummaryProxy = dAfterTexts.some((t) => t.includes("[此前会话的压缩摘要]"));
  const hasOldHistory = dAfterTexts.some((t) => t.includes(PROMPT_A)) && dAfterTexts.some((t) => t.includes(PROMPT_B));
  note(`[底层] 派生文件 ${basename(dAfterFile)}：${dAfterMsgs.length} 条 message、${kernelCompactions(dAfterKernel).length} 条 compaction`);
  note(`[底层] 摘要代身=${hasSummaryProxy}；边界前历史被回灌=${hasOldHistory}`);
  if (summaryCarried) {
    check(hasSummaryProxy && !hasOldHistory,
      "[底层·P4] 有摘要 → seed 投影「摘要代身」：新内核只吃摘要，压缩形态被保住",
      `texts=${JSON.stringify(dAfterTexts.map((t) => t.slice(0, 30)))}`);
  } else {
    check(hasOldHistory,
      "[底层·P4] 无摘要 → seed 投影**保守全量回落**（宁多灌不丢语义）：边界前的历史被完整回灌新内核",
      `texts=${JSON.stringify(dAfterTexts.map((t) => t.slice(0, 30)))}`);
    note("↳ 这正是「分隔线没拿到摘要」的下游后果：摘要没传到中间层，「摘要代身」这条设计路径在生产里走不到。");
  }
  check(kernelCompactions(dAfterKernel).length === 0,
    "[底层] 派生会话的内核文件里没有 compaction 条目（派生 = 重新物化，不是复制压缩状态）");
  const srcNeutralNow = readNeutral(SESS_DIR, SRC_NS);
  const srcKernelNow = readKernelJsonl(srcKernelFile);
  check(neutralEntries(srcNeutralNow).some(isCompactionDivider) && hasText(neutralEntries(srcNeutralNow), PROMPT_D),
    "[中间层] 源会话未被 rewind 改动（压缩分隔线、丁 都还在）");
  check(kernelCompactions(srcKernelNow).length === 1 && kernelMessages(srcKernelNow).length === srcMsgCountAfterD,
    `[底层] 源会话内核文件未被 rewind 改动（message ${kernelMessages(srcKernelNow).length} 条 = 回退前 ${srcMsgCountAfterD} 条、compaction 仍 1 条）`);
  await shot(page, "4-rewind-after");

  // ===== 第 5 段：压缩点之前 rewind（P3 解压）=====
  console.log("\n[5] 切回源会话 → rewind 到压缩点**之前**（回退到乙）");
  const srcRowPath = srcRowPaths.find((p) => p && p.endsWith(`${SRC_NS}.jsonl`)) ?? srcKernelFile;
  await openSessionRow(page, srcRowPath);
  await waitFor(() => page.evaluate((m) =>
    [...document.querySelectorAll("[data-message-id]")].some((r) => (r.textContent || "").includes(m)), PROMPT_B),
  { timeout: 25000, label: "源会话时间线重新渲染出 乙" });
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 15000 }).catch(() => {});
  const bIdx = entriesWithD.findIndex((e) => textOf(e.message).includes(PROMPT_B));
  ok(bIdx > 0 && bIdx < divIdx, `乙 在压缩边界之前、且不是首条（乙@${bIdx}，divider@${divIdx}）`);

  await rewindAt(page, PROMPT_B, REWIND_BEFORE);
  const derivedBeforeNs = await waitFor(() => derivedNsOf(SESS_DIR, SRC_NS, [derivedAfterNs]),
    { timeout: 30000, label: "派生会话（回退到压缩点之前）落中间层" });
  const dBeforeEntries = neutralEntries(readNeutral(SESS_DIR, derivedBeforeNs));
  check(hasText(dBeforeEntries, PROMPT_A),
    "[中间层·P3] 派生会话带着压缩点之前的历史（甲在）：rewind 取数于中间层全量，不受内核压缩影响");
  check(!dBeforeEntries.some(isCompactionDivider),
    "[中间层·P3] 派生会话**不含**压缩分隔线（切点在边界之前 → 压缩在这次派生里被解除）");
  check(!hasText(dBeforeEntries, PROMPT_C) && !hasText(dBeforeEntries, PROMPT_D),
    "[中间层] 边界之后的 丙/丁 没被卷进来（fork 前缀截断正确，不多带）");

  const dBeforeFile = await waitFor(() => {
    const hit = kernelFileOf(home, derivedBeforeNs);
    return hit && kernelMessages(readKernelJsonl(hit)).length > 0 ? hit : null;
  }, { timeout: 90000, label: "派生会话（边界前）的底层内核文件物化" });
  const dBeforeKernel = readKernelJsonl(dBeforeFile);
  const dbTexts = kernelMessages(dBeforeKernel).map((e) => textOf(e.message));
  note(`[底层] 派生文件 ${basename(dBeforeFile)}：${kernelMessages(dBeforeKernel).length} 条 message、`
    + `${kernelCompactions(dBeforeKernel).length} 条 compaction；文本=${JSON.stringify(dbTexts.map((t) => t.slice(0, 18)))}`);
  check(dbTexts.some((t) => t.includes(PROMPT_A)) && !dbTexts.some((t) => t.includes(PROMPT_C)),
    "[底层·P3] 新内核文件 = 压缩点之前的全量历史（含甲、不含丙）→ 冷起后上下文完整回灌");
  check(kernelCompactions(dBeforeKernel).length === 0,
    "[底层·P3] 新内核文件零 compaction 条目：pi 读回的是全量历史，不是摘要");
  check(kernelCompactions(readKernelJsonl(srcKernelFile)).length === 1,
    "[底层] 源会话内核文件仍保有自己的 compaction 条目（派生不动源）");

  const rowsFinal = await uiRows(page);
  const ui2 = {
    rowCount: rowsFinal.length,
    hasA: rowsFinal.some((t) => t.includes(PROMPT_A)),
    hasNew: rowsFinal.some((t) => t.includes(REWIND_BEFORE)),
  };
  check(ui2.hasA && ui2.hasNew, "[UI·P3] 回退后的时间线：压缩点之前的历史 + 新发那条都在",
    `甲=${ui2.hasA} 己=${ui2.hasNew}（行数 ${ui2.rowCount}）`);
  await shot(page, "5-rewind-before");

  const errs = consoleTail.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"));
  check(errs.length === 0, `页面零报错（实测 ${errs.length} 条${errs[0] ? `: ${errs[0].slice(0, 140)}` : ""}）`);

  // ---------- 三层对账总表 ----------
  const cell = (s, w) => String(s).padEnd(Math.max(0, w - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)), " ");
  console.log("\n===== 三层对账总表 =====");
  console.log(`  ${cell("位面", 20)}| ${cell("源会话（压缩后）", 30)}| ${cell("派生A（锚在边界后）", 28)}| 派生B（锚在边界前）`);
  console.log(`  ${cell("底层内核 JSONL", 20)}| ${cell(`${msgIdsAfter.length} msg + 1 compaction`, 30)}| `
    + `${cell(`${dAfterMsgs.length} msg + 0 compaction`, 28)}| ${kernelMessages(dBeforeKernel).length} msg + 0 compaction`);
  console.log(`  ${cell("中间层中立会话", 20)}| ${cell(`${entriesAfter.length} 条（含 1 分隔线，全量）`, 30)}| `
    + `${cell(`${neutralEntries(readNeutral(SESS_DIR, derivedAfterNs)).length} 条（含分隔线）`, 28)}| ${dBeforeEntries.length} 条（无分隔线，全量）`);
  console.log(`  ${cell("UI 时间线", 20)}| ${cell(`${ui.rowCount} 行 + 压缩分隔线`, 30)}| `
    + `${cell("见截图 4-rewind-after", 28)}| ${ui2.rowCount} 行，历史全在`);
  console.log("\n  结论：压缩只改「内核运行时上下文」这一个位面；② ③ 全量保留，rewind 取数于 ② →");
  console.log(`        ${summaryCarried
    ? "边界后保形（摘要代身）、边界前解压（全量回灌）。"
    : "两个方向都把边界前的历史全量回灌新内核（摘要未传到中间层，走了保守回落）。"}`);

  console.log(`\n===== 断言: ${L.state.passed} 通过 / ${L.state.softFailures.length} 失败 =====`);
  for (const f of L.state.softFailures) console.log(`  ✗ ${f}`);
  console.log(`截图: ${SHOTS}`);
  failed = L.state.softFailures.length > 0;
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
