#!/usr/bin/env node
// 会话作用域 e2e(设计 docs/design/session-scope.md §5.3)——真实产物 + 隔离 HOME + CDP,
// 验证 goal 迁移到会话作用域槽后「切会话换档」的核心目的:A 会话的目标绝不出现在 B 会话。
//
// 为什么需要真机 e2e(jsdom 测不了的):切会话换档要经过真实的 ui-store 身份字段变更 →
// scopeKey 重算 → useSessionScope 重渲染 → 目标条 DOM 撤除/复活这条完整链路,还要验
// goal:state 的 scoped channel 坐标注入(绿晕随会话切换而亮灭)。这些是跨进程 + 真实渲染
// 时序,jsdom 的 renderHook 覆盖不到。
//
// 覆盖:
//   A) 会话甲设 /goal → 目标条出现 + 绿晕;
//   B) 切到会话乙 → 目标条消失 + 绿晕熄灭(核心隔离断言:甲的目标不串到乙);
//   C) 乙设自己的 /goal → 乙的目标条(与甲的不同目标);
//   D) 切回甲 → 甲的目标条复活、轮次连续(不被乙污染);
//   E) 物化:new 会话壳设目标 → 首条消息落盘物化 → 目标条仍在(carry + onCarry 头行补写)。
//
// 零 token:models.json 覆写为空清单,/goal 的目标正文真发时 resolveSessionModelPrefs
// 拿不到模型 → 主侧「会话未启动」快速拒绝,零真实回合;goal 状态机与目标条照常运转。
// 用法:npm run build && node scripts/demo/goal-scope.e2e.mjs [--port 9372] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9372" }, keep: { type: "boolean", default: false } } });
const PORT = Number(args.port);
const APP_PORT = 18421;

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const NAME_A = "甲会话";
const NAME_B = "乙会话";
const GOAL_A = "甲的目标-整理报告";
const GOAL_B = "乙的目标-写测试";
const MARK_A = "ALPHA-MARK";
const MARK_B = "BETA-MARK";

// 两个已物化会话(同项目),内容各带一个 marker 便于确认切到了哪个。
const seedRows = (name, mark) => [
  { type: "message", message: { role: "user", stopReason: "end_turn", content: [{ type: "text", text: mark }] } },
  { type: "session_info", name },
  { type: "message", message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: `${mark}-REPLY` }] } },
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
// 空模型清单:/goal 的目标正文真发时拿不到模型 → 快速失败,零真实回合零 token。
writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: {} }));
const fileA = writeSessionFile(ctx.agentDir, proj, seedRows(NAME_A, MARK_A), 1, ctx.defaultModel);
const fileB = writeSessionFile(ctx.agentDir, proj, seedRows(NAME_B, MARK_B), 1, ctx.defaultModel);
console.log(`  种子会话: 甲=${fileA}\n            乙=${fileB}`);

const shotsDir = join(runRoot, "shots");
mkdirSync(shotsDir, { recursive: true });
let shotN = 0;

await assertPortFree(PORT);
const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
const shot = async (name) => { shotN += 1; await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) }); };

/** 真实鼠标点元素(CDP 命中测试,不 dispatch 合成事件)。 */
async function clickEl(page, selector, textIncludes) {
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

/** 打开某会话:点侧栏标题含该名字的会话行,等内容 marker 出现。 */
async function openSession(name, mark) {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("[data-session-path]")].some((el) => (el.textContent || "").includes(n)),
    { timeout: 25000, polling: 300 }, name,
  );
  await clickEl(page, "[data-session-path]", name);
  await page.waitForFunction(
    (m) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(m)),
    { timeout: 20000, polling: 300 }, mark,
  );
}

async function typeIntoComposer(text) {
  await clickEl(page, "[data-timeline-composer]");
  await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    if (!(ta instanceof HTMLTextAreaElement)) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(ta, "");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.keyboard.type(text, { delay: 12 });
}
async function sendGoal(objective) {
  await typeIntoComposer(`/goal ${objective}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction((o) => document.body.innerText.includes(o), { timeout: 8000, polling: 150 }, objective);
}

const goalBarCount = () => page.evaluate(() => document.querySelectorAll("[data-goal-bar]").length);
const goalBarHasText = (t) => page.evaluate((x) => {
  const bar = document.querySelector("[data-goal-bar]");
  return bar ? bar.innerText.includes(x) : false;
}, t);
const composerGoalAccent = () => page.evaluate(() => {
  const ta = document.querySelector("[data-timeline-composer]");
  const pill = ta?.parentElement;
  return !!pill && pill.classList.contains("shell-composer-goal") && pill.getAttribute("data-goal-active") === "true";
});
/** 轮询等绿晕达到期望态。绿晕经 goal:state scoped channel 传播,而 goal 广播是「值变化」
 *  effect 驱动(比 setGoal 晚一个渲染周期)+ timeline 重渲染又一个周期——即时断言会偶发抢跑
 *  (goal-command.e2e 实测间歇失败)。人眼几十 ms 内看到绿晕无感,探针不能赌固定时序(§3.4)。 */
async function waitGoalAccent(want) {
  return page.waitForFunction((w) => {
    const ta = document.querySelector("[data-timeline-composer]");
    const pill = ta?.parentElement;
    const on = !!pill && pill.classList.contains("shell-composer-goal") && pill.getAttribute("data-goal-active") === "true";
    return on === w;
  }, { timeout: 6000, polling: 100 }, want).then(() => true).catch(() => false);
}
const roundText = () => page.evaluate(() => {
  const bar = document.querySelector("[data-goal-bar]");
  const m = bar?.innerText.match(/(\d+)\/(\d+)/);
  return m ? m[0] : null;
});

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-sidebar-style]", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ── A) 会话甲设目标 ──
  await openSession(NAME_A, MARK_A);
  ok((await goalBarCount()) === 0, "A: 甲会话初始无目标条");
  await sendGoal(GOAL_A);
  ok((await goalBarCount()) === 1, "A: /goal 后目标条出现");
  ok(await goalBarHasText(GOAL_A), `A: 目标条显示「${GOAL_A}」`);
  ok(await waitGoalAccent(true), "A: goal 生效,输入框药丸挂绿晕");
  await shot("A-goal-set");

  // ── B) 切到乙:核心隔离断言 ──
  await openSession(NAME_B, MARK_B);
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
  ok((await goalBarCount()) === 0, "B: 切到乙会话后目标条消失(甲的目标不串到乙——迁移核心目的)");
  ok(!(await goalBarHasText(GOAL_A)), "B: 乙会话看不到甲的目标文本");
  ok(await waitGoalAccent(false), "B: 乙会话输入框绿晕熄灭(goal:state scoped channel 按会话过滤)");
  await shot("B-switched-clean");

  // ── C) 乙设自己的目标 ──
  await sendGoal(GOAL_B);
  ok((await goalBarCount()) === 1, "C: 乙会话设自己的目标后目标条出现");
  ok(await goalBarHasText(GOAL_B), `C: 乙目标条显示「${GOAL_B}」`);
  ok(!(await goalBarHasText(GOAL_A)), "C: 乙的目标条不含甲的目标(两会话目标各自独立)");
  await shot("C-goal-B");

  // ── D) 切回甲:复活 + 不被乙污染 ──
  await openSession(NAME_A, MARK_A);
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
  ok((await goalBarCount()) === 1, "D: 切回甲,目标条复活");
  ok(await goalBarHasText(GOAL_A), `D: 复活的是甲的目标「${GOAL_A}」(不是乙的)`);
  ok(!(await goalBarHasText(GOAL_B)), "D: 甲的目标条不含乙的目标(换档读的是甲自己的作用域)");
  await shot("D-back-to-A");

  // ── E) 新会话壳设目标:目标写壳键作用域,目标条在位 ──
  // ⌘N 新建会话(比点 NewChatRow 稳:该行只在无已物化会话时出现,此处已有甲乙两个)。
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await page.keyboard.press("n");
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  ok((await goalBarCount()) === 0, "E: 新会话壳初始无目标条(甲的目标没跟过来)");
  await typeIntoComposer("/goal 物化测试目标");
  await page.keyboard.press("Enter");
  // 壳会话:目标正文经 {send} 真发,但空模型清单 → 主侧快速失败,会话不物化(无真实回合)。
  // 验「壳期目标条在位」(setGoal 写壳键 new:${cwd} 作用域);物化那半(carry 搬到真身键 +
  // onCarry 补写头行)在沙箱里不发生,由 unittest 覆盖(session-pending.test.ts 的搬迁门 +
  // session-scope.test.ts 的 onCarry toKey 参数化)。
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  ok(await goalBarHasText("物化测试目标"), "E: 壳期设目标,目标条在位(写壳键作用域)");
  ok(!(await goalBarHasText(GOAL_A)) && !(await goalBarHasText(GOAL_B)), "E: 新壳会话不含甲/乙的目标(三会话各自独立)");
  await shot("E-shell-goal");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言全部通过(会话作用域隔离:切会话换档,甲的目标不串到乙)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  try {
    await shot("failure");
    const diag = await page.evaluate(() => ({
      goalBars: [...document.querySelectorAll("[data-goal-bar]")].map((b) => b.innerText.slice(0, 60)),
      sessionRows: [...document.querySelectorAll("[data-session-path]")].map((r) => r.textContent?.slice(0, 30)),
      bodySnippet: document.body.innerText.slice(0, 300),
    })).catch(() => null);
    if (diag) console.error("现场:", JSON.stringify(diag, null, 2));
  } catch { /* 诊断失败不掩盖原因 */ }
  await killApp(app).catch(() => {});
  console.error(`诊断截图保留: ${shotsDir}`);
  process.exit(1);
}
