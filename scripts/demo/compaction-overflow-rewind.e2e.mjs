#!/usr/bin/env node
// 超限上下文 ↔ 回退(rewind) e2e —— compaction-rewind.e2e.mjs 的**严重场景**续集。
//
// ## 这条剧本回答什么
//
// 前一条剧本（compaction-rewind）用的是小会话：压缩发生了，但「压缩前」的上下文并没有超限。
// 用户点名的真正危险的场景是：
//
//   **中间层中立会话的内容超过上下文预算，然后 rewind 回到那个超限区间。**
//
// 因为 rewind 的前缀取数于中间层（全量、不压缩），会把超限历史**原样回灌**给新内核进程。
// 这时会发生什么？是壳假装上下文变小了，还是内核诚实地再压一次？中间层会不会因此损坏？
// 这条剧本用真实内核 + 真实模型跑出来，不靠推理。
//
// ## 顺带钉住的一个更严重缺陷（验尸 run1 发现的）
//
// pi 在**压缩失败**时同样发 `compaction_end`（agent-session.ts:1859 / 1937-1945：
// `result: undefined` + `aborted` 或 `errorMessage`）。壳的写穿此前无条件落一条压缩分隔线，
// 于是「内核根本没压缩」也会在中立层留下一条**假边界**。实测现场（run1）：
//   中间层 = …乙 / assistant / divider compaction     ← 有边界
//   底层内核 = compaction 条目 0                       ← 没压缩
// 危害有两层，都不是显示问题：
//   ① `assembleSeedProjection` 找到最新边界就 `break`（session-neutral.ts:489），
//      所以一条**无摘要的假边界会遮蔽更早的真实边界** → 真摘要失效 → 派生会话全量回灌；
//   ② UI 谎报「上下文已压缩」→ 用户以为上下文变小了，实际仍是满的 → 继续发 → 真溢出。
//      这违反 CLAUDE.md §1.5「不静默、不伪造成功」。
// 本剧本用一个**确定性的失败压缩**（刚压完立刻再压 → pi 抛 Already compacted）复现它（Phase C）。
//
// ## 杠杆选型：为什么是 reserveTokens，而不是 contextWindow（选错过两次，都实测过）
//
// 目标是让「会话占用超过可用上下文预算」真实成立，同时**不灌 1M token**。
// contextWindow 看着最直观，但它是**错的杠杆**，因为它同时驱动两个量：
//
//   ① 阈值压缩触发线：shouldCompact = contextTokens > contextWindow − reserveTokens
//      （pi compaction.ts:209；reserveTokens 默认 16384）
//   ② 输出 token 预算：maxTokens = contextWindow − 当前上下文 − 4096，下限夹到 1
//      （packages/ai/src/api/simple-options.ts:15 clampMaxTokensToContext）
//
// 要制造「占用超过窗口」就得 U > W，而 ② 随之变负 → maxTokens 夹成 1 → **每个请求当场失败**：
//   · window=1500（第一版）：现场证据 = 中间层有 丁壬癸子 的 user 条目、零 assistant 回复；
//     而 `_checkCompaction` 需要一条**成功的** assistant 消息才跑（agent-session.ts:1900），
//     于是压缩永不触发，有界重试只是在反复打死端点。
//     ⚠ 我当时把原因猜成「502 撞上摘要生成」并写进了注释——是错的。教训：猜测不能当结论
//       写进注释（会让下一个人照着错前提改），必须先验尸现场文件。
//   · window=16000（第二版）：预算够了，但触发线 = 16000−16384 = **−384**，shouldCompact 恒真
//     ⇒ 那不是「会话超限」，只是「自动压缩被无条件打开」，证不到用户问的场景；
//     且断言建立在 `tokensBefore > window` 上，而实测占用 5328 < 16000 → 会**全部假失败**。
//
// 正确杠杆是 **reserveTokens**：它只进 ①、完全不碰 ②，窗口保持真实值 → 请求永远成功。
// 触发线 = W − reserve，把 reserve 抬到 `W − 目标触发线` 即可精确控制触发线。
//
// ### 还有一个隐藏约束：系统提示词地板
//
// 隔离 HOME 的 settings.json 拷了真实 profile 的 ~30 条 skills，系统提示词本身就占 ~5100 tokens
// （实测 甲 的 usage.input=5246），而三轮短问答的对话内容只有 ~200。后果：
//   · 触发线若低于地板 → 压缩后 usage 仍≈地板 > 触发线 → **每轮都重压**（病态，测不出干净行为）；
//   · 对话占比太小 → 「压缩真的摘要掉了内容」这件事无从观察。
// 所以剧本**注入一段大填充**（乙，~2500 tokens）把对话体量抬到地板之上，并且：
//   · 触发线取 `(地板, 占用)` 区间的 60% 处 —— 高于地板（压缩后不重触发）、低于占用（这一轮必触发）；
//   · 两个端点都是**运行时实测**（F = 首轮后的真实 usage，U = 填充后的真实 usage），
//     不硬编码 —— 换模型、换 skills 体积都不会失效；带宽不足时**响亮失败**并给出该调哪个旋钮。
//
// 同理 keepRecentTokens=1 让 prepareCompaction 在小会话上也能找到切点（否则抛 Nothing to compact）。
// 三者都只改**触发条件**，走的仍是内核真实的阈值检测 → 自动压缩 → 事件 → 壳写穿链路。
//
// ## 用法
//   npm run e2e:compaction-overflow   （= node scripts/demo/compaction-overflow-rewind.e2e.mjs）
//   需要先 npm run build；花真实 token：5 轮问答（含 1 条 ~2500 token 填充）+ 1 次 threshold 压缩摘要
//   + 1 次失败压缩（Phase C，Already compacted，不花摘要）+ 2 次回退重发 + 派生会话超限后再压 1 次。
//   失败时总是保留隔离 HOME（三层原始文件 + 截图）作为诊断现场。
//
// 静默纪律（CLAUDE.md §5.6）：经 lib/app.mjs 的 launchApp → quietEnv（MHD_WINDOW=hidden），
// 窗口永不 show、不抢用户焦点；断言全走 CDP 求值 + 文件读，不依赖窗口可见。
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import {
  makeLedger, waitFor,
  readKernelJsonl, kernelMessages, kernelCompactions, kernelMessageTexts,
  listKernelSessionFiles, nsOfKernelFile, kernelFileOf,
  readNeutral, neutralEntries, isCompactionDivider, neutralDialog, textOf, hasText, derivedNsOf,
  patchPiSettings, defaultModelContextWindow, realContextTokens,
  sendAndWait, uiRows, uiBodyText, rewindAt, openSessionRow, callCompact,
  revealMessageRow, scrollTimelineToTop, scrollTimelineToBottom,
} from "./lib/session-layers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "9373" },
    keep: { type: "boolean", default: false },
    // 触发线在 (地板 F, 占用 U) 区间里的位置（0=贴着地板, 1=贴着占用）。
    // 0.6 偏向上半区：离占用够近（这一轮必触发），又明显高于地板（压缩后不会每轮重触发）。
    "threshold-ratio": { type: "string", default: "0.6" },
    // 填充轮的目标 token 数（≈ chars/4）。默认 2500 → 约 10000 字符。
    // 太小则带宽 (U−F) 不足、触发线无处安放；剧本会在带宽不足时响亮失败并提示调大它。
    "filler-tokens": { type: "string", default: "2500" },
    // 压缩后必须低于触发线的安全余量（tokens）。用来校验「压缩不会每轮重触发」。
    "post-margin": { type: "string", default: "400" },
  },
});
const CDP_PORT = Number(args.port);
const APP_PORT = 18473;
const THRESHOLD_RATIO = Number(args["threshold-ratio"]);
const FILLER_TOKENS = Number(args["filler-tokens"]);
const POST_MARGIN = Number(args["post-margin"]);

// 极短问答。匹配一律用**完整 prompt 文本**：压缩摘要里可能出现单字标记，用单字判会假阳性。
//
// 时序（每个角色都是后面某个断言的锚，别随意挪）：
//   甲（短）    → 量出系统提示词**地板 F**（首轮 usage ≈ 地板 + 一点点对话）
//   乙（填充）  → 把占用抬到 U = F + ~2500，制造「会话超过可用预算」的前提；**Phase F 的回退锚**
//                 （回退到乙 ⇒ 前缀 = [甲, 乙填充]，恰好是超限区间本身）
//   丙（短）    → 边界前最后一条，用来验「fork 不多带边界之后的内容」
//   丁（短）    → 抬 reserve 后发它 ⇒ 收尾检查看到 usage > 触发线 ⇒ 内核自主 threshold 压缩，
//                 压缩边界落在丁之后
//   戊（短）    → 压缩之后发 ⇒ 天然落在边界之后，**Phase E 的回退锚**（验摘要代身）
//
// ⚠ 触发机制（读 pi 源码定案，不是猜）：pi 有两个压缩检查点 ——
//   ① agent 收尾后 `_handlePostAgentRun` → `_checkCompaction(msg)`；
//   ② 下一次 prompt 之前 `_checkCompaction(lastAssistant, false)`（agent-session.ts:1155-1161）。
//   抬 reserve 后 shouldCompact(U, W, reserve) 为真 → **下一个成功回合**在检查点 ① 就触发
//   threshold 压缩（reason="threshold"，内核自主发起，壳全程没调 compact()）。
//   threshold 压缩的 willRetry=false → `_runAutoCompaction` 返回 hasQueuedMessages()（通常 false）
//   → **不会**在同一回合内循环重压（agent-session.ts:2128-2142）。
//
// ⚠ 为什么要**有界重试**：摘要生成本身是一次模型调用，端点偶发失败时它挂 → 压缩失败 →
//   pi 发 compaction_end{result:undefined, errorMessage} → 壳若无条件落分隔线就产生「假边界」
//   （这正是 Phase C 的靶子）。Phase B/F2 因此重试发真实短消息，每次走内核真实压缩检查，
//   直到真实压缩条目落地；上限防呆（端点持续失败时明确失败而非空转）。重试是内核自愈路径，
//   不是脚本造假。
const P_FLOOR = "只回复一个字：甲";
const P_FILLER_HEAD = "下面是一段用于占满上下文的资料，请只回复一个字：乙";
const P_AFTER_FILLER = "只回复一个字：丙";
const P_TRIGGER = "只回复一个字：丁"; // 抬 reserve 后第一条 → 触发 threshold 压缩
const P_ANCHOR_AFTER = "只回复一个字：戊"; // 压缩之后发 → Phase E 的回退锚（边界后）
const RW_AFTER = "只回复一个字：己"; // 回退到戊（边界后）时重发
const RW_BEFORE = "只回复一个字：庚"; // 回退到乙（边界前的超限区间）时重发
const RETRY_MARKS = ["辛", "壬", "癸", "子", "丑"];

/** 确定性填充文本：≈ FILLER_TOKENS 个 token（按 pi 的 chars/4 口径估）。
 *  用带序号的句子而不是重复同一个词——重复词会被缓存/压得更狠，序号行更接近真实长上下文。 */
function buildFiller(targetTokens) {
  const targetChars = targetTokens * 4;
  const parts = [];
  let i = 0;
  while (parts.join("\n").length < targetChars) {
    parts.push(`第${i}条资料：这一行是为了把会话上下文抬到超过可用预算而填充的内容，编号 ${i} 便于核对完整性。`);
    i += 1;
    if (i > 4000) break; // 防呆：目标设得离谱时不至于把内存吃掉
  }
  return parts.join("\n");
}

/** 填充内部的一个独特探针（不是指令头）。
 *
 *  为什么不用指令头 P_FILLER_HEAD 来判「填充原文在不在」：那条断言要证明的是
 *  「派生会话里填充原文**缺席**、已被摘要顶替」，而摘要是模型生成的——模型完全可能
 *  把「请只回复一个字：乙」这类指令原样回显进摘要，用指令头判就会**假阳性**（明明只剩摘要，
 *  却被判成原文还在）。序号行（"第40条资料"）是数据不是指令，摘要几乎不会逐字复现，
 *  拿它当探针对「原文 vs 摘要」的区分才是可靠的。同一探针在 Phase E（应缺席）与
 *  Phase F1（应在场）两个方向上用，对称。 */
const FILLER_PROBE = "第40条资料";

// ---------- 环境准备 ----------
if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物，先跑: npm run build");
  process.exit(1);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// keepRecentTokens=1：让 prepareCompaction 在小会话上也能找到切点（否则抛 Nothing to compact）。
// reserveTokens 留到 Phase B 由实测反算后再写（此刻先不动，保持默认 → Phase A 不会误触发压缩）。
patchPiSettings(home, { compaction: { enabled: true, keepRecentTokens: 1 } });
const MODEL = defaultModelContextWindow(home);
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
console.log(`默认模型 ${MODEL.provider}/${MODEL.modelId}，contextWindow = ${MODEL.contextWindow}（保持真实值不改，见头注「杠杆选型」）`);
console.log(`杠杆 = compaction.reserveTokens（只进触发线、不碰输出预算）；填充目标 ≈ ${FILLER_TOKENS} tokens\n`);

const app = await launchApp({ appDir: ROOT, port: CDP_PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("console", (m) => consoleTail.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleTail.push(`[pageerror] ${e.message}`));

/** 发一条消息并把回合收敛 + DOM 静默都等完（本剧本所有发送共用，避免各 Phase 各写一遍）。 */
async function send(text) {
  await sendAndWait(page, text);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 15000 }).catch(() => {});
}

/** 有界重试直到**真实**压缩条目落地（摘要调用偶发失败时的自愈路径，见头注）。
 *  返回带 compaction 条目的底层内核条目数组；重试耗尽返回 null（调用方据此响亮失败）。 */
async function sendUntilCompacted(kernelFile, firstText) {
  await send(firstText);
  for (let attempt = 0; attempt <= RETRY_MARKS.length; attempt++) {
    const es = readKernelJsonl(kernelFile);
    if (kernelCompactions(es).length > 0) return es;
    if (attempt === RETRY_MARKS.length) break;
    note(`第 ${attempt + 1} 次未见真实压缩条目（摘要那次模型调用可能失败）→ 再发一条真实消息催内核压缩检查`);
    await send(`只回复一个字：${RETRY_MARKS[attempt]}`);
  }
  const es = readKernelJsonl(kernelFile);
  return kernelCompactions(es).length > 0 ? es : null;
}

let failed = false;
try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  ok(true, "应用启动、composer 可用（窗口 hidden，未抢用户焦点）");

  // ===== Phase A：默认配置下建历史，并**实测**地板与占用 =====
  console.log("\n[A] 默认 reserve 下建立历史：甲（量地板）→ 乙（填充）→ 丙");
  await send(P_FLOOR);
  const kernelFiles = listKernelSessionFiles(home);
  ok(kernelFiles.length === 1, `底层内核 session 文件已生成（实测 ${kernelFiles.length} 个）`);
  const srcKernelFile = kernelFiles[0];
  const SRC_NS = nsOfKernelFile(srcKernelFile);
  note(`ns = ${SRC_NS}`);

  const FLOOR = realContextTokens(readKernelJsonl(srcKernelFile));
  ok(FLOOR != null && FLOOR > 0, `量出系统提示词地板 F = ${FLOOR} tokens（首轮真实 usage）`);

  const filler = `${P_FILLER_HEAD}\n${buildFiller(FILLER_TOKENS)}`;
  note(`填充文本长度 ${filler.length} 字符（≈${Math.round(filler.length / 4)} tokens）`);
  await send(filler);
  await send(P_AFTER_FILLER);

  const USAGE = realContextTokens(readKernelJsonl(srcKernelFile));
  ok(USAGE != null && USAGE > FLOOR, `填充后内核自报占用 U = ${USAGE} tokens`);
  const BANDWIDTH = USAGE - FLOOR;
  // 带宽不足就别往下走：触发线无处安放，硬跑只会得到一串看不懂的红（响亮失败 + 指明旋钮）。
  ok(BANDWIDTH >= POST_MARGIN + 200,
    `带宽 U−F = ${BANDWIDTH} tokens 足够安放触发线（需 ≥ ${POST_MARGIN + 200}）`,
    `不够就调大 --filler-tokens（当前 ${FILLER_TOKENS}）`);
  check(kernelCompactions(readKernelJsonl(srcKernelFile)).length === 0,
    "[底层] 默认 reserve 下全程未触发压缩（阈值线在 ~98 万，远高于占用）——Phase A 是干净的基线");
  const neutralA = readNeutral(SESS_DIR, SRC_NS);
  ok(!!neutralA, "中间层中立会话已落盘（header + entries 双文件）");
  const entriesA = neutralEntries(neutralA);
  const dialogA = neutralDialog(entriesA);
  check(dialogA.length >= 6, `[中间层] ≥6 条对话条目（实测 ${dialogA.length}）`);
  check([P_FLOOR, P_AFTER_FILLER].every((p) => hasText(entriesA, p)),
    "[中间层] 甲/丙 的 user 条目都在（填充轮按前缀匹配，见下条）");
  check(hasText(entriesA, FILLER_PROBE), "[中间层] 填充轮的 user 条目在（中间层存的是全量原文）");
  note(`中间层此刻保有 ${dialogA.length} 条对话原文，其中含那段 ~${Math.round(filler.length / 4)} token 的填充`);
  await shot(page, "A-history");

  // ===== Phase B：抬 reserve 把触发线压到占用之下 → 内核自主 threshold 压缩 =====
  const FIRE_LINE = Math.round(FLOOR + BANDWIDTH * THRESHOLD_RATIO);
  const RESERVE = MODEL.contextWindow - FIRE_LINE;
  console.log(`\n[B] 抬 reserveTokens 把触发线压到占用之下 → 发丁 → 内核自主压缩`);
  note(`推导：触发线 = W − reserve = ${MODEL.contextWindow} − ${RESERVE} = ${FIRE_LINE}`);
  note(`校验：地板 ${FLOOR} < 触发线 ${FIRE_LINE} < 占用 ${USAGE} ⇒ 这一轮必触发，且压缩后掉回地板附近不会每轮重触发`);
  patchPiSettings(home, { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: RESERVE } });
  note("（settings.json 在 pi 的 configDepPaths 里 → 壳据此重建内核进程，新 reserve 生效）");

  const kernelB = await sendUntilCompacted(srcKernelFile, P_TRIGGER);
  ok(!!kernelB, "抬 reserve 后内核**自主**压缩落地（threshold，全程没调壳的 compact()，是内核自己判定的）");
  const compB = kernelCompactions(kernelB)[0];
  check(typeof compB.tokensBefore === "number" && compB.tokensBefore > FIRE_LINE,
    `[底层] 压缩确实因为超过触发线发生：tokensBefore=${compB.tokensBefore} > ${FIRE_LINE}`,
    `tokensBefore=${JSON.stringify(compB.tokensBefore)}`);
  check(typeof compB.summary === "string" && compB.summary.length > 0,
    `[底层] compaction 条目带真实摘要（长度 ${String(compB.summary ?? "").length} 字符）`);
  check(typeof compB.firstKeptEntryId === "string" && compB.firstKeptEntryId.length > 0,
    "[底层] compaction 条目带 firstKeptEntryId（运行时上下文的保留起点）");

  const neutralB = await waitFor(() => {
    const s = readNeutral(SESS_DIR, SRC_NS);
    return s && neutralEntries(s).some(isCompactionDivider) ? s : null;
  }, { timeout: 30000, label: "中间层出现压缩分隔线" });
  const entriesB = neutralEntries(neutralB);
  const divB = entriesB.find(isCompactionDivider)?.message ?? {};
  check(typeof divB.detail === "string" && divB.detail.length > 0,
    "[中间层] 分隔线带摘要 detail（**自动**压缩路径同样把摘要传到了壳，不只手动 compact）",
    `detail=${JSON.stringify(divB.detail)}；i18nArgs=${JSON.stringify(divB.i18nArgs)}`);
  check(!!divB.i18nArgs?.tokens, "[中间层] 分隔线带 tokens（UI 能显示压缩前占用）",
    `i18nArgs=${JSON.stringify(divB.i18nArgs)}`);

  // 核心量化：两个位面在同一时刻的口径分歧
  const msgCountB = kernelMessages(kernelB).length;
  check(msgCountB >= 6,
    `[底层·append-only] 超限压缩后 message 行仍全量在文件里（实测 ${msgCountB} 条，一条没删）`);
  check(neutralDialog(entriesB).length >= dialogA.length,
    `[中间层·append-only] 对话条目只增不减（${dialogA.length} → ${neutralDialog(entriesB).length}）`);
  // UI 层：时间线是 react-virtuoso **虚拟列表** + alignToBottom（打开即贴底），
  // 一次只渲染视口附近的行。所以「历史全部可见」不能靠一屏断言——那是把虚拟列表当全量列表的
  // 错误前提（run3 实测：早期消息被移出 DOM，rowCount 只有 9）。正确做法是分位置验：
  // 滚到顶验最早的甲仍在、滚到底验压缩分隔线 + 丁仍在。内容完整性由上面的 ①/② 两层文件断言保证。
  //
  // ⚠ 顺序有讲究：revealMessageRow 内部是「置顶 → 向下扫到目标即停」，所以**先**用它把
  //   视口停在丁，再读 body 找分隔线，就会因为分隔线在丁之后、尚未渲染而假失败（run6 实测）。
  //   故先滚到底读分隔线（分隔线是末尾几条之一，贴底必渲染），再去找丁。
  await scrollTimelineToTop(page);
  const revealedFloor = await revealMessageRow(page, P_FLOOR);
  const rowsTop = await uiRows(page);
  check(revealedFloor && rowsTop.some((t) => t.includes(P_FLOOR)),
    "[UI] 滚到顶：超限压缩后**最早**的消息（甲）仍在时间线里（外部 session 没被压掉）",
    `滚到顶后行数 ${rowsTop.length}，甲在=${rowsTop.some((t) => t.includes(P_FLOOR))}`);
  await scrollTimelineToBottom(page);
  const bodyB = await uiBodyText(page);
  check(bodyB.includes("上下文已压缩"), "[UI] 时间线渲染出压缩分隔线",
    `贴底后 body 未含「上下文已压缩」；尾部文案=${JSON.stringify(bodyB.slice(-120))}`);
  const revealedTrigger = await revealMessageRow(page, P_TRIGGER);
  const rowsB = await uiRows(page);
  check(revealedTrigger && rowsB.some((t) => t.includes(P_TRIGGER)),
    "[UI] 触发压缩的丁仍在时间线里（滚到底后经 revealMessageRow 命中）", `行数 ${rowsB.length}`);
  note(`口径分歧：中间层仍保有 ${neutralDialog(entriesB).length} 条对话原文（含那段填充，超限态），`
    + `而内核运行时已换成 ${String(compB.summary ?? "").length} 字符的摘要（tokensBefore=${compB.tokensBefore}）`);
  await shot(page, "B-after-threshold-compaction");

  // ===== Phase C：失败压缩不得留假边界（本次修复的靶心）=====
  //
  // 如何**确定性**地制造一次失败压缩（run3 实测校准过，别退回单次调用）：
  //   pi 的 prepareCompaction 只在「路径上最后一条是 compaction」时返回 undefined，
  //   agent-session.ts 据此抛「Already compacted」→ catch 里发
  //   compaction_end{result: undefined, errorMessage} —— 这就是失败事件路径。
  //   ⚠ 单次 compact() **不够**：Phase B 的自动压缩发生在发丁之前（pre-prompt 检查），
  //   所以此刻最后一条是丁的 assistant，compact() 会**成功**再压一次（run3 实测：
  //   底层多出第二条真实 compaction，tokensBefore=5646），根本走不到失败分支。
  //   正确做法是连调两次：第 1 次真压（末条变成 compaction）→ 第 2 次必然抛 Already compacted。
  //   这条失败路径与「摘要那次模型调用挂了」走的是**同一个事件形状**，但确定性可复现、不赌端点。
  console.log("\n[C] 确定性的失败压缩（连调两次 compact → Already compacted）→ 验「假边界」不再产生");
  // C-1：先做一次**成功**的手动压缩，把「最后一条 = compaction」这个前提摆好。
  const errC1 = await callCompact(page, "为 Phase C 铺垫：先成功压一次");
  check(errC1 === null, "C-1 铺垫压缩成功（末条从此是 compaction 条目）", `errC1=${JSON.stringify(errC1)}`);
  const dividersAfterC1 = await waitFor(() => {
    const n = neutralEntries(readNeutral(SESS_DIR, SRC_NS)).filter(isCompactionDivider).length;
    return n >= 2 ? n : null;
  }, { timeout: 30000, interval: 400, label: "C-1 的压缩分隔线落中间层" });
  note(`C-1 后：底层 compaction ${kernelCompactions(readKernelJsonl(srcKernelFile)).length} 条、中间层分隔线 ${dividersAfterC1} 条`);

  // C-2：紧接着再压一次 → 必然失败 → 这才是被测的失败事件。
  const beforeC = {
    kernelCompactions: kernelCompactions(readKernelJsonl(srcKernelFile)).length,
    neutralDividers: neutralEntries(readNeutral(SESS_DIR, SRC_NS)).filter(isCompactionDivider).length,
    neutralCount: neutralEntries(readNeutral(SESS_DIR, SRC_NS)).length,
  };
  const errC = await callCompact(page, "再压一次（预期失败）");
  note(`第二次 compact() 返回: ${JSON.stringify(errC)}`);
  check(!!errC && /already compacted/i.test(errC),
    "第二次压缩被内核以「Already compacted」拒绝（这就是我们要的失败路径，不是脚本出错）",
    `errC=${JSON.stringify(errC)}`);
  // 等失败事件写穿：以「中立层条目数稳定」为准，不赌固定 sleep
  await waitFor(() => {
    const n = neutralEntries(readNeutral(SESS_DIR, SRC_NS)).length;
    return n === beforeC.neutralCount ? n : null;
  }, { timeout: 15000, interval: 500, label: "失败压缩后中立层稳定（无新条目）" }).catch(() => {});
  const afterC = {
    kernelCompactions: kernelCompactions(readKernelJsonl(srcKernelFile)).length,
    neutralDividers: neutralEntries(readNeutral(SESS_DIR, SRC_NS)).filter(isCompactionDivider).length,
    neutralCount: neutralEntries(readNeutral(SESS_DIR, SRC_NS)).length,
  };
  note(`底层 compaction 条目 ${beforeC.kernelCompactions} → ${afterC.kernelCompactions}；`
    + `中间层分隔线 ${beforeC.neutralDividers} → ${afterC.neutralDividers}；条目总数 ${beforeC.neutralCount} → ${afterC.neutralCount}`);
  check(afterC.kernelCompactions === beforeC.kernelCompactions,
    "[底层] 失败的压缩没有在内核留下 compaction 条目（内核是诚实的）");
  check(afterC.neutralDividers === beforeC.neutralDividers,
    "[中间层·★假边界] 失败的压缩**不再**留下分隔线（compacted=false → 壳不落边界）",
    `分隔线 ${beforeC.neutralDividers} → ${afterC.neutralDividers}。若这里多出一条，就是假边界回归：`
    + `它会遮蔽更早的真摘要（assembleSeedProjection 找到最新边界即 break）、并让 UI 谎报已压缩`);
  check(afterC.neutralCount === beforeC.neutralCount,
    "[中间层] 失败的压缩没往中立层塞任何条目", `条目 ${beforeC.neutralCount} → ${afterC.neutralCount}`);
  // 失败要在 UI 上显形（§1.5 不静默）：toast 文案含「压缩失败」
  const toastSeen = await waitFor(() => uiBodyText(page).then((b) => (b.includes("压缩失败") ? b : null)),
    { timeout: 8000, interval: 300, label: "压缩失败的 toast 显形" }).catch(() => null);
  check(!!toastSeen, "[UI·不静默] 压缩失败对用户显形（toast「上下文压缩失败…」），不是静默无反应",
    "timeline 应在 compacted===false 且非 aborted 时 showToast(shell.compactionFailed, error)");
  await shot(page, "C-failed-compaction");

  // ===== Phase D：恢复默认 reserve + 发一条落在边界之后的锚（戊）=====
  // 恢复默认 reserve：后续两个回退实验先要在「不会随手触发压缩」的干净态下观察，
  // 否则每发一条就压一次，判读不出 fork/seed 本身的行为（Phase F2 再把它压回去）。
  // 发 戊：它是 Phase E（回退到边界之后）的锚点，必须**在压缩之后**发出 → 天然落在分隔线之后。
  console.log("\n[D] 恢复默认 reserve → 发戊（落在压缩边界之后，作 Phase E 的回退锚）");
  patchPiSettings(home, { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 } });
  note("reserve 恢复 16384 → 触发线回到 ~98 万，远高于占用（后续回合不再随手压缩）");
  await send(P_ANCHOR_AFTER);
  const entriesD = neutralEntries(readNeutral(SESS_DIR, SRC_NS));
  const divIdx = entriesD.findIndex(isCompactionDivider);
  const anchorAfterIdx = entriesD.findIndex((e) => textOf(e.message).includes(P_ANCHOR_AFTER));
  ok(divIdx >= 0 && anchorAfterIdx > divIdx, `戊 在压缩边界之后（divider@${divIdx} < 戊@${anchorAfterIdx}）`);
  const srcMsgCountD = kernelMessages(readKernelJsonl(srcKernelFile)).length;
  const srcRowPaths = await page.evaluate(() =>
    [...document.querySelectorAll("[data-session-path]")].map((r) => r.getAttribute("data-session-path")));
  await shot(page, "D-before-rewind");

  // ===== Phase E：rewind 到压缩点**之后** → 摘要代身在真实摘要下生效 =====
  console.log("\n[E] rewind 到压缩点**之后**（回退到戊）→ 摘要代身");
  await rewindAt(page, P_ANCHOR_AFTER, RW_AFTER);
  const nsE = await waitFor(() => derivedNsOf(SESS_DIR, SRC_NS), { timeout: 30000, label: "派生会话（边界后）落中间层" });
  const fileE = await waitFor(() => {
    const hit = kernelFileOf(home, nsE);
    return hit && kernelMessages(readKernelJsonl(hit)).length > 0 ? hit : null;
  }, { timeout: 90000, label: "派生会话（边界后）的底层内核文件物化" });
  const kernelE = readKernelJsonl(fileE);
  const textsE = kernelMessageTexts(kernelE);
  note(`[底层] 派生文件 ${basename(fileE)}：${kernelMessages(kernelE).length} msg、${kernelCompactions(kernelE).length} compaction`);
  note(`[底层] 文本=${JSON.stringify(textsE.map((t) => t.slice(0, 24)))}`);
  check(textsE.some((t) => t.includes("[此前会话的压缩摘要]")),
    "[底层·摘要代身] 派生会话的内核文件里是**摘要代身**，不是超限原文（压缩形态被保住）");
  check(!textsE.some((t) => t.includes(FILLER_PROBE)),
    "[底层·摘要代身] 边界前那段填充原文没有被回灌（探针「第40条资料」不在，说明它被摘要顶替了）",
    `texts=${JSON.stringify(textsE.map((t) => t.slice(0, 24)))}`);
  check(kernelCompactions(kernelE).length === 0,
    "[底层] 派生文件零 compaction 条目（派生 = 重新物化，不是复制压缩状态）");
  const entriesE = neutralEntries(readNeutral(SESS_DIR, nsE));
  check(entriesE.some(isCompactionDivider) && hasText(entriesE, FILLER_PROBE),
    "[中间层] 派生会话的中立层仍是**全量**（含边界前填充原文 + 那条分隔线）——只有喂内核的投影才截断");
  check(kernelCompactions(readKernelJsonl(srcKernelFile)).length === beforeC.kernelCompactions
    && kernelMessages(readKernelJsonl(srcKernelFile)).length === srcMsgCountD,
  "[底层] 源会话未被 rewind 改动（compaction/message 条数都不变）");
  await shot(page, "E-rewind-after");

  // ===== Phase F1：★核心 —— rewind 回**超限区间**（边界之前）=====
  console.log("\n[F1] ★核心：切回源会话 → rewind 到压缩点**之前**的超限区间（回退到乙/填充轮）");
  const srcRowPath = srcRowPaths.find((p) => p && p.endsWith(`${SRC_NS}.jsonl`)) ?? srcKernelFile;
  await openSessionRow(page, srcRowPath);
  // 丙 是早期消息，重开会话后时间线贴底 → 丙被虚拟化移出 DOM。用 revealMessageRow 滚上去找它，
  // 而不是傻等它「渲染出来」（run3 就是在这里超时的：数据层完好，只是不在视口）。
  const revealedC = await revealMessageRow(page, P_AFTER_FILLER);
  ok(revealedC, "源会话时间线重新渲染出 丙（经滚动揭示，虚拟列表下早期消息不在首屏）");
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 15000 }).catch(() => {});

  const entriesF0 = neutralEntries(readNeutral(SESS_DIR, SRC_NS));
  const fillerIdx = entriesF0.findIndex((e) => textOf(e.message).includes(P_FILLER_HEAD));
  const afterFillerIdx = entriesF0.findIndex((e) => textOf(e.message).includes(P_AFTER_FILLER));
  const divIdx2 = entriesF0.findIndex(isCompactionDivider);
  ok(fillerIdx > 0 && afterFillerIdx > fillerIdx && afterFillerIdx < divIdx2,
    `锚点次序正确（填充@${fillerIdx} < 丙@${afterFillerIdx} < divider@${divIdx2}）：回退到丙 ⇒ 前缀含填充、且在边界之前`);
  const prefixDialog = neutralDialog(entriesF0.slice(0, afterFillerIdx));
  note(`回退前缀含 ${prefixDialog.length} 条对话原文（甲 + 那段 ~${Math.round(filler.length / 4)} token 填充）；`
    + `源会话压缩前内核自报 tokensBefore=${compB.tokensBefore} > 触发线 ${FIRE_LINE}（即超限态）`);

  // 此刻 reserve 是默认值（Phase D 恢复的）→ 首发不会触发压缩 → 派生会话停在
  // 「fork 刚物化完」的纯净态，能干净地断言解压语义。（若此时 reserve 仍是低的，
  //  首发就会触发第二次压缩，污染下面几条断言 —— 这是本剧本改过一次的时序坑。）
  await rewindAt(page, P_AFTER_FILLER, RW_BEFORE);
  const nsF = await waitFor(() => derivedNsOf(SESS_DIR, SRC_NS, [nsE]), { timeout: 30000, label: "派生会话（边界前）落中间层" });
  const entriesF = neutralEntries(readNeutral(SESS_DIR, nsF));
  check(hasText(entriesF, FILLER_PROBE),
    "[F1·中间层] 派生会话带着压缩点之前的**超限原文**（那段填充在）：rewind 取数于中间层全量，压缩拦不住它");
  check(!entriesF.some(isCompactionDivider),
    "[F1·中间层] 派生会话不含**源**那条压缩分隔线（切点在边界之前 → 源压缩在这次派生里被解除）");
  check(!hasText(entriesF, P_TRIGGER) && !hasText(entriesF, P_ANCHOR_AFTER),
    "[F1·中间层] 边界之后的 丁/戊 没被卷进来（fork 前缀截断正确，不多带）");

  const fileF = await waitFor(() => {
    const hit = kernelFileOf(home, nsF);
    return hit && kernelMessages(readKernelJsonl(hit)).length > 0 ? hit : null;
  }, { timeout: 90000, label: "派生会话（边界前）的底层内核文件物化" });
  const kernelF0 = readKernelJsonl(fileF);
  const textsF0 = kernelMessageTexts(kernelF0);
  note(`[F1·底层] 派生文件 ${basename(fileF)}：${kernelMessages(kernelF0).length} msg、${kernelCompactions(kernelF0).length} compaction`);
  check(textsF0.some((t) => t.includes(FILLER_PROBE)) && !textsF0.some((t) => t.includes(P_TRIGGER)),
    "[F1·底层·P3] 超限原文被**原样回灌**新内核文件（含填充、不含丁）：壳不替内核决定「压缩过了就少灌」");
  check(!textsF0.some((t) => t.includes("[此前会话的压缩摘要]")),
    "[F1·底层·P3] 回灌的是原文而不是摘要（前缀里没有边界，assembleSeedProjection 无从截断）");
  check(kernelCompactions(kernelF0).length === 0,
    "[F1·底层] 默认 reserve 下首发不触发压缩，派生文件此刻零 compaction 条目（解压态干净）");

  // ===== Phase F2：★核心 —— 让回灌的超限上下文重新超限，看内核诚实处理 =====
  //
  // ⚠ 触发线必须按**派生会话自己的实测占用**重算，不能复用 Phase B 的 FIRE_LINE（run6 逻辑 bug）：
  //   派生会话只回灌了「甲 + 填充」（≈地板+填充），比源会话（还含丙丁戊）小一截；
  //   复用按源会话算出的触发线会导致 派生占用 < 触发线 → shouldCompact 恒假 → 压缩永不触发，
  //   sendUntilCompacted 白重试到耗尽、报「内核没再压」这种**假失败**。
  //   同一套自校准公式（触发线 = 地板 + 带宽×ratio）在这里再跑一遍即可，保持「地板 < 线 < 占用」。
  console.log("\n[F2] ★核心：按派生会话实测占用重算触发线 → 内核自主再压一次");
  const USAGE_F = realContextTokens(kernelF0);
  ok(USAGE_F != null && USAGE_F > FLOOR,
    `派生会话实测占用 U_F = ${USAGE_F} tokens > 地板 ${FLOOR}（填充原文确实被回灌进来了）`,
    `U_F=${USAGE_F}`);
  const BANDWIDTH_F = USAGE_F - FLOOR;
  ok(BANDWIDTH_F >= POST_MARGIN + 200,
    `派生会话带宽 U_F−F = ${BANDWIDTH_F} tokens 够放触发线（需 ≥ ${POST_MARGIN + 200}）`,
    `不够就调大 --filler-tokens（当前 ${FILLER_TOKENS}）`);
  const FIRE_LINE_F = Math.round(FLOOR + BANDWIDTH_F * THRESHOLD_RATIO);
  const RESERVE_F = MODEL.contextWindow - FIRE_LINE_F;
  note(`派生会话触发线 = W − reserve = ${MODEL.contextWindow} − ${RESERVE_F} = ${FIRE_LINE_F}`);
  note(`校验：地板 ${FLOOR} < 触发线 ${FIRE_LINE_F} < 占用 ${USAGE_F} ⇒ 下一轮必触发`);
  patchPiSettings(home, { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: RESERVE_F } });
  const kernelF = await sendUntilCompacted(fileF, "只回复一个字：辛");
  if (kernelF) {
    const compF = kernelCompactions(kernelF)[0];
    ok(true, "[F2·★核心] 超限回灌后**内核自己又压了一次**（reason 由内核判定，壳没参与）——rewind 逃不掉超限，也不该逃");
    check(typeof compF.tokensBefore === "number" && compF.tokensBefore > FIRE_LINE_F,
      `[F2·★核心] 派生会话的压缩同样因超过触发线发生：tokensBefore=${compF.tokensBefore} > ${FIRE_LINE_F}`,
      `tokensBefore=${JSON.stringify(compF.tokensBefore)}`);
    check(kernelMessages(kernelF).length >= kernelMessages(kernelF0).length,
      `[F2·★核心] 第二次压缩后底层仍 append-only（message ${kernelMessages(kernelF0).length} → ${kernelMessages(kernelF).length}，一条没删）`);
    check(textsF0.every((t) => kernelMessageTexts(kernelF).some((t2) => t2 === t)),
      "[F2·★核心] F1 那批原文 message 行在第二次压缩后**逐条仍在**（超限原文没被删，只是被摘要遮蔽）");
    const entriesF2 = neutralEntries(readNeutral(SESS_DIR, nsF));
    check(entriesF2.some(isCompactionDivider) && hasText(entriesF2, FILLER_PROBE),
      "[F2·★核心] 派生会话的中间层：既有它自己的新分隔线、又仍保有全部超限原文（两层各自 append-only）");
    check(neutralDialog(entriesF2).length >= neutralDialog(entriesF).length,
      `[F2·★核心] 派生会话中间层对话条目只增不减（${neutralDialog(entriesF).length} → ${neutralDialog(entriesF2).length}）`);
    const compCountF = kernelCompactions(kernelF).length;
    check(compCountF === 1, `[F2·★核心] 派生会话只压了 1 次（实测 ${compCountF}）：压缩后占用掉回地板附近、低于触发线，不每轮重压`);
  } else {
    check(false, "[F2·★核心] 超限回灌后内核应自主再压一次（重试耗尽仍无 compaction 条目）",
      "可能：reserve 未被新内核进程拾取，或派生占用未超触发线 → 看现场文件");
  }
  // F2 后时间线贴底，甲是最早的消息、多半被虚拟化移出 DOM → 用 revealMessageRow 滚上去找它，
  // 而不是直接读 uiRows（那是把虚拟列表当全量列表的错误前提，run6 在此假失败）。
  const revealedF = await revealMessageRow(page, P_FLOOR);
  const rowsF = await uiRows(page);
  check(revealedF && rowsF.some((t) => t.includes(P_FLOOR)),
    "[F2·UI] 回退到超限区间后，时间线上压缩点之前的历史（甲）仍在",
    `甲=${rowsF.some((t) => t.includes(P_FLOOR))}（reveal=${revealedF}，行数 ${rowsF.length}）`);
  await shot(page, "F-rewind-before-overflow");

  // ===== 收尾 =====
  const errs = consoleTail.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"));
  check(errs.length === 0, `页面零报错（实测 ${errs.length} 条${errs[0] ? `: ${errs[0].slice(0, 140)}` : ""}）`);

  console.log("\n===== 超限场景三层对账总表 =====");
  const cell = (s, w) => String(s).padEnd(Math.max(0, w - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)), " ");
  const srcKernelFinal = readKernelJsonl(srcKernelFile);
  const kE = readKernelJsonl(fileE);
  const kF = kernelFileOf(home, nsF) ? readKernelJsonl(kernelFileOf(home, nsF)) : [];
  console.log(`  ${cell("位面", 20)}| ${cell("源会话（超限压缩后）", 30)}| ${cell("派生E（锚在边界后）", 28)}| 派生F（锚在超限区间）`);
  console.log(`  ${cell("底层内核 JSONL", 20)}| ${cell(`${kernelMessages(srcKernelFinal).length} msg + ${kernelCompactions(srcKernelFinal).length} compaction`, 30)}| `
    + `${cell(`${kernelMessages(kE).length} msg + 0 compaction（摘要代身）`, 28)}| ${kernelMessages(kF).length} msg + ${kernelCompactions(kF).length} compaction（回灌后再压）`);
  console.log(`  ${cell("中间层中立会话", 20)}| ${cell(`${entriesD.length} 条（全量 + 1 分隔线）`, 30)}| `
    + `${cell(`${entriesE.length} 条（全量 + 分隔线）`, 28)}| ${neutralEntries(readNeutral(SESS_DIR, nsF)).length} 条（全量 + 自己的分隔线）`);
  console.log(`  ${cell("UI 时间线", 20)}| ${cell(`${rowsB.length} 行 + 压缩线`, 30)}| ${cell("见截图 E", 28)}| ${rowsF.length} 行，历史全在`);
  console.log(`\n  实测校准值：地板 F=${FLOOR}，填充后占用 U=${USAGE}，带宽=${BANDWIDTH}，触发线=${FIRE_LINE}，reserve=${RESERVE}`);
  console.log(`  内核运行时：超限后被摘要替换（tokensBefore=${compB.tokensBefore} → 摘要 ${String(compB.summary ?? "").length} 字符）`);
  console.log("  中间层：始终保有全部对话原文（含那段填充，超限态也不瘦身），rewind 取数于它 →");
  console.log("\n  结论：中间层与内核运行时**口径不同是设计**（全量给人看 / 压缩给模型用）。");
  console.log("        rewind 到超限区间会把超限原文原样回灌，内核随后自主再压一次——");
  console.log("        没有任何一层为了「看起来没超限」而丢数据；压缩失败也不伪造边界。");

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
