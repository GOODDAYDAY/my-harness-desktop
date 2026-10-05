// 三层会话语面的读取与驱动原语 —— compaction 系列 e2e 的共用地基。
//
// ## 为什么抽出来（§1.1 判别气味三：同一逻辑在多个外部入口各写一遍）
//
// compaction 系列剧本都要做同样三件事：读底层内核 JSONL、读中间层中立会话、驱动 UI 回退。
// 两份剧本各抄 150 行 = 改一处忘一处的标准温床（例如「等 ns 落盘」的轮询判据曾把字符串
// 返回值误当诊断信息，两个剧本会各修一遍）。收敛到这里，剧本只剩「命题 + 断言」。
//
// ## 三个位面的物理位置（契约见各自源码）
//
//   ① 底层内核 session   ~/.pi/agent/sessions/<bucket>/<lineageId>.jsonl
//                        pi 私有格式：type/id/parentId 树 + usage。append-only。
//   ② 中间层中立会话     ~/.my-harness-desktop-dev/sessions/<ns>.{header,entries}.json
//                        壳的真相源（session-single-source）：线性化、内核无关、全量。
//   ③ UI 时间线          renderer 镜像，锚点 [data-message-id] / [data-session-path]。
//
// 另有第四个位面**不落盘**：pi 进程内的运行时上下文（agent.state.messages，由
// buildSessionContext(①) 现算）。压缩改的就是它——所以「压缩」是读取时的解释规则，
// 不是删除操作。剧本只能通过 ①②③ 的落盘物间接观察它。
//
// ## 纪律
//   · 事件驱动等待（waitFor），不赌固定 sleep（§3.6）。
//   · 锚点只用稳定 data-*，不按 class/文案层级猜（§交互测试）。
//   · 窗口永不 show：经 lib/app.mjs 的 launchApp → quietEnv（§5.6 测试静默）。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==============================================================================================
// ① 底层内核 session（pi JSONL）
// ==============================================================================================

/** 逐行 parse（半截行跳过——写入竞态时下一轮再读，不因为读到半行就判失败）。 */
export function readKernelJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半截行 */ }
  }
  return out;
}
export const kernelMessages = (es) => es.filter((e) => e.type === "message");
export const kernelCompactions = (es) => es.filter((e) => e.type === "compaction");
export const kernelMessageTexts = (es) => kernelMessages(es).map((e) => textOf(e.message));

/** 从底层内核 JSONL 里取**内核自报**的真实上下文占用（最后一条带有效 usage 的 assistant）。
 *  这是 pi 自己判溢出用的那个量（calculateContextTokens = usage.totalTokens 或 input+output+cache），
 *  比壳侧 chars/4 估算诚实——超限剧本用它量化「中间层会话超过上下文」这个前提，
 *  而不是拿自估的废数字（早期版本自估出「≈14 tokens」，已弃用）。
 *  读不到（无 usage）返回 null，调用方据此显式降级，不当 0。 */
export function realContextTokens(kernelEntries) {
  let best = null;
  for (const e of kernelEntries) {
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const u = e.message.usage;
    if (!u) continue;
    const t = u.totalTokens || ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
    if (typeof t === "number" && t > 0) best = t;
  }
  return best;
}

/** 扫隔离 HOME 下 pi 的全部会话文件（隔离区起跑是空的，扫到的一定是本次运行产生的）。 */
export function listKernelSessionFiles(home) {
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
export const nsOfKernelFile = (p) => basename(p, ".jsonl");
/** root lineage 的 lineageId ≡ neutralSessionId，且路径是 lineageId 的确定性函数
 *  （piDerivedSessionPath，§12.2）→ 按 ns 反查内核文件，不用猜桶名。 */
export const kernelFileOf = (home, ns) => listKernelSessionFiles(home).find((p) => nsOfKernelFile(p) === ns) ?? null;

// ==============================================================================================
// ② 中间层中立会话（壳的真相源）
// ==============================================================================================

/** header/entries 拆分双文件（neutral-session-store.ts 的文件契约）。 */
export function readNeutral(sessDir, ns) {
  const hp = join(sessDir, `${ns}.header.json`);
  const ep = join(sessDir, `${ns}.entries.json`);
  if (!existsSync(hp) || !existsSync(ep)) return null;
  const h = JSON.parse(readFileSync(hp, "utf-8"));
  const e = JSON.parse(readFileSync(ep, "utf-8"));
  return { ns, rootLineageId: h.rootLineageId, header: h.header ?? {}, lineages: e.lineages ?? [] };
}
export const neutralEntries = (s, lid) => (s?.lineages.find((l) => l.lineageId === (lid ?? s.rootLineageId))?.entries ?? []);
export const isDivider = (e) => e.message?.role === "divider";
export const isCompactionDivider = (e) => isDivider(e) && e.message?.kind === "compaction";
/** 对话条目（user/assistant/toolResult）——divider 是展示层元条目，不算对话内容。 */
export const neutralDialog = (list) => list.filter((e) => !isDivider(e));
export const textOf = (m) => (typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map((c) => c?.text ?? "").join("") : "");
export const hasText = (list, needle) => list.some((e) => textOf(e.message).includes(needle));

/** 列出由 srcNs 派生（fork）出来的中立会话 ns（rewind/retry/分叉都走这条）。 */
export function derivedNsOf(sessDir, srcNs, exclude = []) {
  for (const f of readdirSync(sessDir).filter((x) => x.endsWith(".header.json"))) {
    const ns = f.replace(/\.header\.json$/, "");
    if (ns === srcNs || exclude.includes(ns)) continue;
    const d = readNeutral(sessDir, ns)?.header?.derivedFrom;
    if (d?.kind === "fork" && d.sourceNeutralSessionId === srcNs) return ns;
  }
  return null;
}

// ==============================================================================================
// 内核配置改写（只动隔离 HOME 的副本，不碰真实 profile）
// ==============================================================================================

/** 浅合并写 pi 的 settings.json（compaction.* / retry.* 等）。 */
export function patchPiSettings(home, patch) {
  const p = join(home, ".pi", "agent", "settings.json");
  const cur = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    next[k] = (v && typeof v === "object" && !Array.isArray(v)) ? { ...(cur[k] ?? {}), ...v } : v;
  }
  writeFileSync(p, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/** 读**默认模型**的 contextWindow（只读，不改）。
 *
 *  为什么是只读、不再提供「改窗口」的 helper（实测踩过两次，教训写在这里）：
 *  contextWindow 同时驱动两个量，改它必然两头拉扯——
 *    ① 阈值压缩触发线 = contextWindow − reserveTokens（pi compaction.ts:209 shouldCompact）；
 *    ② 输出 token 预算 = contextWindow − 当前上下文 − 4096，下限夹到 1
 *       （packages/ai/src/api/simple-options.ts:15 clampMaxTokensToContext）。
 *  要制造「会话超过上下文」就得 U > W，而 ② 随之变负 → maxTokens 夹成 1 → **每个请求当场失败**
 *  （run2 现场：丁壬癸子 只有 user 条目、零 assistant 回复；当时误判成 502）。
 *  所以制造超限的合法杠杆是 **reserveTokens**（只进 ①、完全不碰 ②，窗口保持真实值 → 请求永远成功），
 *  窗口只需要**读出来**用于反算 reserve = W − 目标触发线。
 *  完整推导见 compaction-overflow-rewind.e2e.mjs 头注「杠杆选型」那节。 */
export function defaultModelContextWindow(home) {
  const mp = join(home, ".pi", "agent", "models.json");
  const sp = join(home, ".pi", "agent", "settings.json");
  if (!existsSync(mp)) throw new Error(`models.json 不存在: ${mp}`);
  const models = JSON.parse(readFileSync(mp, "utf-8"));
  const settings = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf-8")) : {};
  for (const [prov, pc] of Object.entries(models.providers ?? {})) {
    for (const m of pc.models ?? []) {
      if (prov === settings.defaultProvider && m.id === settings.defaultModel) {
        return { provider: prov, modelId: m.id, contextWindow: m.contextWindow ?? null };
      }
    }
  }
  throw new Error(`默认模型没找到（defaultProvider=${settings.defaultProvider} defaultModel=${settings.defaultModel}）`);
}

// ==============================================================================================
// 事件驱动等待 + 断言台账
// ==============================================================================================

/** fn 返回真值即命中并原样返回，falsy 继续轮询；超时抛错。
 *  ⚠ 返回值可以是字符串（ns 就是字符串）——早期版本把「字符串返回」当诊断信息，
 *  于是等 ns 的调用点永远命中不了（实测：派生会话早已落盘却报等待超时）。
 *  诊断信息只从抛错里取。 */
export async function waitFor(fn, { timeout = 60000, interval = 400, label = "条件" } = {}) {
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

/** 带圈数字序号(①…㉑…㊱)，覆盖 1-50。给断言台账自动编号用。 */
const CIRCLED = [
  ...Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x2460 + i)), // ①-⑳
  ...Array.from({ length: 15 }, (_, i) => String.fromCodePoint(0x3251 + i)), // ㉑-㉟
  ...Array.from({ length: 15 }, (_, i) => String.fromCodePoint(0x32b1 + i)), // ㊱-㊿
];
const ordinal = (n) => CIRCLED[n - 1] ?? `#${n}`;

/** 断言台账：hard 立即抛（下游已无意义时），soft 记账继续（一次运行看全貌）。
 *  soft 失败照样让退出码非 0——不为了「跑完」而放过缺陷。
 *
 *  **序号由台账自动分配**，剧本不手写 ①②③。为什么这是机制而不是风格：
 *  手工编号在「中途插入一条断言」时必然错位（实测：Phase B 加了两条断言后，
 *  Phase E 的 ⑲⑳ 与 Phase D 的 ⑲⑳ 撞号，同一份日志里两个断言共用一个编号，
 *  引用编号的注释随之全错）。收敛到这里，编号与断言一一对应是构造保证的，
 *  插入/删除断言不再需要重排全文（§3.3 框架管通用）。 */
export function makeLedger() {
  const state = { passed: 0, softFailures: [], total: 0 };
  const next = () => { state.total += 1; return ordinal(state.total); };
  return {
    state,
    ok(cond, label) {
      const tag = next();
      if (!cond) throw new Error(`断言失败(hard) ${tag}: ${label}`);
      state.passed += 1;
      console.log(`  ✓ ${tag} ${label}`);
      return true;
    },
    check(cond, label, detail) {
      const tag = next();
      if (cond) { state.passed += 1; console.log(`  ✓ ${tag} ${label}`); return true; }
      state.softFailures.push(`${tag} ${label}`);
      console.log(`  ✗ ${tag} ${label}${detail ? `\n      实测: ${detail}` : ""}`);
      return false;
    },
    note(msg) { console.log(`      ${msg}`); },
  };
}

// ==============================================================================================
// ③ UI 驱动（React 受控 textarea 写入 + 可信点击）
// ==============================================================================================

export const setComposer = (page, text, sel = "[data-timeline-composer]") => page.evaluate((s, t) => {
  const ta = document.querySelector(s);
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, t);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  return true;
}, sel, text);

export const clickSend = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    (x.getAttribute("aria-label") || x.title || "").includes("发送") && x.getBoundingClientRect().width > 0);
  if (!b) return false;
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
});

/** 等回合收敛：先等「停止」出现（回合真起跑），再等它消失（收敛）。两段都事件驱动。 */
export async function settle(page, timeoutMs = 180000) {
  const appeared = await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).then(() => true).catch(() => false);
  if (appeared) {
    await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: timeoutMs, polling: 500 });
  }
}

export async function sendAndWait(page, text) {
  if (!(await setComposer(page, text))) throw new Error("composer 不可用");
  if (!(await clickSend(page))) throw new Error("发送按钮不可用");
  await settle(page);
}

/** 时间线当前渲染的消息行文本（③ 的统一读口）。
 *  ⚠ 时间线是 **react-virtuoso 虚拟列表**：只有视口附近的行在 DOM 里。
 *  长会话下「某条消息在不在 DOM」≠「它在不在会话里」——判内容完整性必须读 ①/② 两层文件，
 *  UI 断言只能针对**当前滚动位置**渲染出来的行（配 revealMessageRow 先把目标滚进视口）。 */
export const uiRows = (page) => page.evaluate(() =>
  [...document.querySelectorAll("[data-message-id]")].map((r) => (r.textContent || "")));

/** 触发 app **自己的**滚动快捷键（keybindings 插件的 DEFAULT_BINDINGS）：
 *  `mod+shift+up` → `timeline:scrollTo {position:"top"}` → `virtuosoRef.scrollToIndex({index:0})`。
 *  为什么走快捷键而不是直接掰 `scrollTop`：时间线的 Virtuoso 配了 `alignToBottom` + `followOutput`，
 *  直接改 scrollTop 会和它的钉底补偿对抗（实测：设 0 后又被拉回底部附近）。
 *  经 app 官方入口滚动，Virtuoso 自己维护索引与测量，才是它设计的用法。
 *  darwin 上 mod=meta（combo.ts 的 comboMatches 要求 meta xor ctrl 恰好一个）。 */
async function pressScrollShortcut(page, direction) {
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press(direction === "top" ? "ArrowUp" : "ArrowDown");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  await sleep(400); // 等 smooth 滚动 + Virtuoso 重渲染落定
}

/** 把时间线滚到顶部（虚拟列表下这是「让最早的消息进 DOM」的唯一办法）。 */
export async function scrollTimelineToTop(page) {
  await pressScrollShortcut(page, "top");
  // 兜底：快捷键未生效（keybindings 插件被禁用/改绑）时退回直接置 scrollTop
  const atTop = await page.evaluate(() => {
    const sc = document.querySelector("[data-virtuoso-scroller]");
    if (!sc) return null;
    if (sc.scrollTop > 4) sc.scrollTop = 0;
    return sc.scrollTop <= 4;
  });
  if (atTop === false) await sleep(300);
  return atTop !== null;
}

/** 把时间线滚到底部（回到贴底态，让最新消息 + 压缩分隔线进 DOM）。 */
export async function scrollTimelineToBottom(page) {
  await pressScrollShortcut(page, "bottom");
  const atBottom = await page.evaluate(() => {
    const sc = document.querySelector("[data-virtuoso-scroller]");
    if (!sc) return null;
    sc.scrollTop = sc.scrollHeight;
    return true;
  });
  await sleep(300);
  return atBottom !== null;
}

/** 让含 markerText 的消息行**真的进 DOM**（虚拟列表专用）。
 *
 *  为什么需要它：Virtuoso 配了 alignToBottom + initialTopMostItemIndex=length-1，
 *  打开会话即贴底，早期消息被虚拟化移出 DOM。此时 `scrollIntoView` 无从下手
 *  （元素根本不存在），rewind 的 hover/点击也就找不到行 —— 实测表现为
 *  「源会话时间线重新渲染出 X」等待超时，而数据层其实完好。
 *
 *  ⚠ 方向必须是「先归位到顶，再逐步向下找」（run6 实测踩过的根因）：
 *  首版只会向上滚，于是找**底部**的消息（触发压缩的丁）时，滚到底后未命中就继续向上滚，
 *  反而把目标滚出视口 → 永远找不到。单向扫描对「目标在下方」的场景结构性失效。
 *
 *  ⚠ 步进用 `page.mouse.wheel` 而不是 `keyboard.press("PageDown")`：焦点很可能在 composer
 *  的 textarea 里，PageDown 会滚输入框而不是消息列表。mouse.wheel 是**可信 CDP 输入**，
 *  由浏览器原生滚动列表（JS 合成的 WheelEvent 不会触发原生滚动，那是无效的）。
 *  滚前把鼠标移到列表中央，确保滚轮命中列表而不是侧栏。 */
export async function revealMessageRow(page, markerText, { timeout = 30000 } = {}) {
  const found = () => page.evaluate((m) =>
    [...document.querySelectorAll("[data-message-id]")].some((r) => (r.textContent || "").includes(m)), markerText);
  if (await found()) return true;
  await scrollTimelineToTop(page);
  if (await found()) return true;

  // 鼠标移到列表中央（滚轮命中处）；拿不到就把鼠标放在视口中央。
  const at = await page.evaluate(() => {
    const sc = document.querySelector("[data-virtuoso-scroller]");
    const r = (sc ?? document.body).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(at.x, at.y);

  const deadline = Date.now() + timeout;
  let lastTop = -1;
  let stalls = 0;
  while (Date.now() < deadline) {
    await page.mouse.wheel({ deltaY: 700 });
    await sleep(300); // 等 Virtuoso 按新视口测量并渲染出对应区间的行
    if (await found()) return true;
    const st = await page.evaluate(() => {
      const sc = document.querySelector("[data-virtuoso-scroller]");
      return sc ? { top: sc.scrollTop, max: Math.max(0, sc.scrollHeight - sc.clientHeight) } : null;
    });
    if (st == null) return false; // 没有滚动容器（时间线未挂载）
    // 到底判定：已抵底，或连续 3 次滚动没有位移（Virtuoso 钉底补偿吃掉了滚轮）
    if (st.top >= st.max - 2 || st.top === lastTop) {
      stalls += 1;
      if (stalls >= 3) return found();
    } else {
      stalls = 0;
    }
    lastTop = st.top;
  }
  return found();
}

/** 时间线正文（查分隔线文案用）。 */
export const uiBodyText = (page) => page.evaluate(() => document.body.innerText);

/** 在某条 user 消息行上执行真实 rewind：定位 → hover → 点「回退」→ 内联框写入 → 提交。
 *  锚点全是稳定 data-*（data-message-id / data-rewind-inline）。
 *  ⚠ 先经 revealMessageRow 把目标滚进 DOM —— 虚拟列表下目标可能不在渲染区间，
 *  直接 scrollIntoView 会静默失败（元素不存在），表现为「找不到消息行」。 */
export async function rewindAt(page, userPromptText, newText) {
  if (!(await revealMessageRow(page, userPromptText))) {
    const rows = await page.evaluate(() => [...document.querySelectorAll("[data-message-id]")].map((r) => (r.textContent || "").trim().slice(0, 24)));
    throw new Error(`rewind 定位失败：滚动到顶仍未在 DOM 里找到 ${JSON.stringify(userPromptText)}（现有行: ${JSON.stringify(rows)}）`);
  }
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
export async function openSessionRow(page, sessionPath) {
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

/** 经契约 API 触发一次真实压缩（renderer → IPC session:compact → pi `compact` RPC）。
 *  返回错误字符串或 null——失败也是**被测行为**（例如二次压缩会抛 Already compacted），
 *  所以不在这里抛，由剧本决定怎么断言。 */
export const callCompact = (page, customInstructions) => page.evaluate(async (ci) => {
  try { await window.kernel.sessions.compact(ci); return null; }
  catch (e) { return String(e?.message ?? e); }
}, customInstructions);
