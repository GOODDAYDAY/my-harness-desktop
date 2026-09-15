#!/usr/bin/env node
// 内容钉键口径 e2e(设计 docs/design/session-scope.md §3.3.2)——真机验证「钉入后读得到自己的钉」。
//
// 被守的 bug(迁移前实测存在):session-colors 的**写入**用 currentSessionPath 当键、
// **读取**用 `currentNeutralSessionId ?? currentSessionPath` 当键。对有中立主键的正常会话,
// 同一个会话被劈成两个键 → 钉进去之后当前会话立刻读不到自己的钉。可观测症状:
// 消息行的「钉图钉」按钮点一次后 title **不翻转**成「拔图钉」(pinned 判定读的是另一个键)。
//
// 修法:两侧统一用作用域 key(圆心 sessionScopeKey 单源)。本剧本把这个可观测信号钉死。
//
// 另外验跨会话聚合面板:图钉面板按会话分组列出,sessionInfos 是 path+ns 双键索引,
// 直接 Object.keys 会让同一会话出现两组(uniqueSessionKeys 去重前的症状)。
//
// 零 token(只读会话文件 + DOM 交互,不发送)。
// 用法:npm run build && node scripts/demo/content-pin-key.e2e.mjs [--port=9385] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { writeSessionFile } from "./lib/seed/session-writer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9385" }, keep: { type: "boolean", default: false } } });
const PORT = Number(args.port);
const APP_PORT = 18424;

let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? ` — 实际 ${JSON.stringify(detail)}` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const PROJDIR = null; // 下方 setup 后覆盖
const NAME_A = "钉键甲";
const MARK_A = "PINKEY-A-MARK";
const seedRows = (name, mark) => [
  { type: "message", message: { role: "user", stopReason: "end_turn", content: [{ type: "text", text: mark }] } },
  { type: "session_info", name },
  { type: "message", message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: `${mark}-REPLY 这是可以被钉的正文` }] } },
];

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const proj = join(home, "proj");
mkdirSync(proj, { recursive: true });
ctx.writeConfig("projects", { recentCwds: [proj] });
ctx.setPrefs({ lastCwd: proj });
writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: {} }));
writeSessionFile(ctx.agentDir, proj, seedRows(NAME_A, MARK_A), 1, ctx.defaultModel);

const shotsDir = join(runRoot, "shots");
mkdirSync(shotsDir, { recursive: true });
let shotN = 0;

await assertPortFree(PORT);
const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
const shot = async (name) => { shotN += 1; await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) }); };

async function clickEl(selector, textIncludes) {
  const rect = await page.evaluate(({ sel, text }) => {
    const els = [...document.querySelectorAll(sel)];
    const el = text ? els.find((e) => (e.textContent || "").includes(text)) : els[0];
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, { sel: selector, text: textIncludes ?? null });
  if (!rect) throw new Error(`未找到可点元素: ${selector}${textIncludes ? ` (含「${textIncludes}」)` : ""}`);
  await page.mouse.click(rect.x, rect.y);
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 5000 }).catch(() => {});
}
/** 悬停到某消息行中心(消息动作钮 hover 才淡入)。 */
async function hoverMessage(mark) {
  const pt = await page.evaluate((m) => {
    const el = [...document.querySelectorAll("[data-message-id]")].find((e) => (e.textContent || "").includes(m));
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, mark);
  if (!pt) throw new Error(`未找到含 ${mark} 的消息行`);
  await page.mouse.move(pt.x, pt.y);
  await new Promise((r) => setTimeout(r, 700));
}
/** 某消息行内指定 title 的按钮是否存在。 */
const rowHasButton = (mark, title) => page.evaluate(([m, t]) => {
  const row = [...document.querySelectorAll("[data-message-id]")].find((e) => (e.textContent || "").includes(m));
  return !!row?.querySelector(`button[title="${t}"]`);
}, [mark, title]);
/** 点消息行内指定 title 的按钮(可信点击:取坐标后 mouse.click)。 */
async function clickRowButton(mark, title) {
  const pt = await page.evaluate(([m, t]) => {
    const row = [...document.querySelectorAll("[data-message-id]")].find((e) => (e.textContent || "").includes(m));
    const btn = row?.querySelector(`button[title="${t}"]`);
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, [mark, title]);
  if (!pt) throw new Error(`消息行 ${mark} 内没有 title="${title}" 的按钮`);
  await page.mouse.click(pt.x, pt.y);
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 5000 }).catch(() => {});
}
/** 打开右面板的图钉页签。 */
/** 点图钉面板调色板里的某个颜色(svg ellipse fill 匹配,与 record.mjs 的 palettePin 同法)→ 进 pinMode。 */
async function clickPaletteColor(hex) {
  const pt = await page.evaluate((h) => {
    const el = document.querySelector(`svg ellipse[fill="${h}"]`);
    if (!el) return null;
    const btn = el.closest("button") ?? el;
    btn.scrollIntoView({ block: "center" });
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, hex);
  if (!pt) throw new Error(`调色板没有颜色 ${hex}(图钉面板是否已打开?)`);
  await page.mouse.click(pt.x, pt.y);
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
}
/** 划词钉入:pinMode 下点消息行(走 onPointerDown → addContentPin,即被修的那条写入路径)。
 *
 *  落点纪律(实测踩坑):点**左侧文本区**(x=18%, y=50%)。偏右上方会命中 hover 动作钮
 *  (复制/钉图钉/回退)——那些钮经 portal 浮层渲染,`elementFromPoint` 拿到的是钮而不是
 *  `[data-message-id]` 子树,onDown 的 `closest("[data-message-id]")` 落空,钉不进去。 */
async function clickMessage(mark) {
  // 先把鼠标移到侧栏,消掉消息行的 hover 浮层(否则浮层可能盖住落点)
  await page.mouse.move(60, 300);
  await new Promise((r) => setTimeout(r, 400));
  const pt = await page.evaluate((m) => {
    const el = [...document.querySelectorAll("[data-message-id]")].find((e) => (e.textContent || "").includes(m));
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width * 0.18, y: r.y + r.height * 0.5 };
  }, mark);
  if (!pt) throw new Error(`未找到含 ${mark} 的消息行`);
  await page.mouse.click(pt.x, pt.y);
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
}

async function openPinPanel() {
  // 幂等:右面板页签是 toggle,已展开时再点会关掉。先查调色板(svg ellipse)在不在,
  // 在就说明图钉面板已展开,直接返回(否则第二次调用会把面板关掉,后续断言全空)。
  const alreadyOpen = await page.evaluate(() => !!document.querySelector('[data-sidepanel-style] svg ellipse[fill]'));
  if (alreadyOpen) return;
  const found = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-sidepanel-style] button[aria-label], [data-sidepanel-style] button[title]')]
      .find((b) => (b.getAttribute("aria-label") || b.getAttribute("title") || "").includes("图钉"));
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!found) throw new Error("右面板没有「图钉」页签按钮");
  await page.mouse.click(found.x, found.y);
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
}

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-sidebar-style]", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开种子会话(已物化、有中立主键 ns——正是键空间分裂 bug 的触发条件)
  // 把 proj 目录注入页面作用域(诊断用)
  await page.evaluate((p) => { window.__PROJDIR = p; }, proj);
  await page.waitForFunction((n) => [...document.querySelectorAll("[data-session-path]")].some((el) => (el.textContent || "").includes(n)), { timeout: 25000, polling: 300 }, NAME_A);
  await clickEl("[data-session-path]", NAME_A);
  await page.waitForFunction((m) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(m)), { timeout: 20000, polling: 300 }, MARK_A);

  // [数据层诊断] 这个 seed 会话到底有没有中立主键 ns —— 键空间分裂 bug 的前提。
  // [前提校验] 这个 seed 会话必须有中立主键 ns、且 ns 与投影路径**不同形**——
  // 否则「写 path 键 / 读 ns 键」的分裂根本触发不了,守卫会假绿(实测踩过)。
  const ident = await page.evaluate(async (cwd) => {
    const list = await window.kernel.sessions.list(cwd);
    const s = list[0];
    return s ? { ns: s.neutralSessionId ?? null, path: s.path } : null;
  }, await page.evaluate(() => window.__PROJDIR));
  ok(!!ident?.ns, "前提:seed 会话有中立主键 ns(键空间分裂 bug 的触发条件)", ident);
  ok(ident.ns !== ident.path, "前提:ns 与投影路径不同形(同形则分裂不可观测、守卫假绿)", ident);

  // ── ① 未钉状态 ──
  ok(await page.evaluate(() => document.querySelectorAll("[data-session-colors-pin]").length === 0), "① 初始无图钉节点");
  await shot("1-unpinned");

  // ── ② 走**划词钉入路径**(onPointerDown → addContentPin)钉一枚 ──
  // 这条路径才是键空间分裂 bug 的现场:迁移前它写 currentSessionPath 键,而所有读取侧
  // (消息行渲染 / ContentPinAction 的 pinned 判定 / 图钉面板)读的是 ns 键 → 钉进去读不到。
  // 注意:ContentPinAction 按钮路径**没有**这个 bug(它读写都用 `ns ?? path`),
  // 所以必须走划词路径,否则守卫假绿(实测:探针改划词路径、e2e 走按钮路径 → 全绿)。
  await openPinPanel();
  await clickPaletteColor("#89b4fa");          // 选色 → 进 pinMode(指针模态)
  await clickMessage(`${MARK_A}-REPLY`);       // 钉 assistant 行(正文长、落点稳)
  const pinned = await page.waitForFunction((m) => {
    const row = [...document.querySelectorAll("[data-message-id]")].find((e) => (e.textContent || "").includes(m));
    return !!row?.querySelector("[data-session-colors-pin]");
  }, { timeout: 6000, polling: 150 }, `${MARK_A}-REPLY`).then(() => true).catch(() => false);
  ok(pinned, "② 划词钉入后消息上出现图钉节点(写入键与读取键同源——迁移前此处必失败)");
  await shot("2-pinned");
  // 退出钉入模态:pinMode 是**指针模态**(onDown/onClickCapture 在捕获相截停消息行上的交互),
  // 不退出的话后续 hover 动作钮点了也不生效。Esc 是插件自己的退出口(onKey)。
  await page.keyboard.press("Escape");
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 4000 }).catch(() => {});

  // ── ②b 读取侧消费面:ContentPinAction 的 pinned 判定读得到这枚钉 ──
  await hoverMessage(`${MARK_A}-REPLY`);
  ok(await rowHasButton(`${MARK_A}-REPLY`, "拔图钉"), "②b ContentPinAction 的 pinned 判定读到该钉(title=「拔图钉」)");

  // ── ③ 图钉面板读取侧:当前会话的内容钉列在「消息图钉」段(preview 可见)──
  // 面板的 groupContentPins 也用 scopeKey 读 contentPins——同一个键空间分裂 bug 的**读取侧**:
  // 写入用 path 键、面板读 ns 键时面板会空。preview 出现即证明读写两侧同源。
  // 当前会话的内容钉不显示会话名分组标题(只有非当前会话才显示 groupTitle),故断言 preview。
  await openPinPanel();
  const panel = await page.evaluate(() => {
    const area = document.querySelector("[data-sidepanel-style]");
    return area ? area.innerText : "";
  });
  ok(panel.includes("消息图钉"), "③ 面板出现「消息图钉」分段(内容钉区渲染)");
  ok(panel.includes(MARK_A), "③ 当前会话的内容钉 preview 列在面板(读取侧同键,迁移前此处会空)");
  await shot("3-pin-panel");

  // ── ④ 拔出(走 ContentPinAction 的「拔图钉」)→ 钉节点消失、title 翻回 ──
  // 跨路径一致性:划词路径钉入的钉能被按钮路径拔出——证明两侧读写的是同一个键。
  await hoverMessage(`${MARK_A}-REPLY`);
  await clickRowButton(`${MARK_A}-REPLY`, "拔图钉");
  await hoverMessage(MARK_A);
  const unflipped = await page.waitForFunction((m) => {
    const row = [...document.querySelectorAll("[data-message-id]")].find((e) => (e.textContent || "").includes(m));
    return !!row?.querySelector('button[title="钉图钉"]');
  }, { timeout: 6000, polling: 150 }, `${MARK_A}-REPLY`).then(() => true).catch(() => false);
  ok(unflipped, "④ 拔出后 title 翻回「钉图钉」");
  ok(await page.evaluate((m) => {
    const row = [...document.querySelectorAll("[data-message-id]")].find((e) => (e.textContent || "").includes(m));
    return !row?.querySelector("[data-session-colors-pin]");
  }, `${MARK_A}-REPLY`), "④ 拔出后消息上无图钉节点");
  await shot("4-unpinned-again");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言全部通过(内容钉键口径统一:钉入即读得到自己的钉)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  try {
    await shot("failure");
    const diag = await page.evaluate(() => ({
      pinNodes: document.querySelectorAll("[data-session-colors-pin]").length,
      rowButtons: [...document.querySelectorAll("[data-message-id] button[title]")].map((b) => b.getAttribute("title")).slice(0, 20),
    })).catch(() => null);
    if (diag) console.error("现场:", JSON.stringify(diag, null, 2));
  } catch { /* 诊断失败不掩盖原因 */ }
  await killApp(app).catch(() => {});
  console.error(`诊断截图保留: ${shotsDir}`);
  process.exit(1);
}
