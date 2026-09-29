#!/usr/bin/env node
// 会话作用域的 DOM 组装审查(设计 docs/design/session-scope.md;用户要求"看 DOM 组装是否混乱")。
//
// 与 goal-scope.e2e.mjs 的分工:那个验**行为**(切会话换档、隔离),这个验**结构**——
// 目标条在 ComposerDock 里的位置、composerTop 槽只有一个贡献、绿晕挂在药丸而非输入框本体、
// 切会话后 DOM 里不残留上一个会话的节点(幽灵节点是作用域类 bug 的典型残影)。
//
// 用法:npm run build && node scripts/demo/goal-scope-dom.e2e.mjs [--port=9383] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9383" }, keep: { type: "boolean", default: false } } });
const PORT = Number(args.port);
const APP_PORT = 18423;

let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail ? ` — 实际 ${JSON.stringify(detail)}` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const NAME_A = "结构甲";
const NAME_B = "结构乙";
const GOAL_A = "结构审查目标甲";
const MARK_A = "STRUCT-A-MARK";
const MARK_B = "STRUCT-B-MARK";
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
writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: {} }));
writeSessionFile(ctx.agentDir, proj, seedRows(NAME_A, MARK_A), 1, ctx.defaultModel);
writeSessionFile(ctx.agentDir, proj, seedRows(NAME_B, MARK_B), 1, ctx.defaultModel);

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
async function openSession(name, mark) {
  await page.waitForFunction((n) => [...document.querySelectorAll("[data-session-path]")].some((el) => (el.textContent || "").includes(n)), { timeout: 25000, polling: 300 }, name);
  await clickEl("[data-session-path]", name);
  await page.waitForFunction((m) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(m)), { timeout: 20000, polling: 300 }, mark);
}
async function typeIntoComposer(text) {
  await clickEl("[data-timeline-composer]");
  await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    if (!(ta instanceof HTMLTextAreaElement)) return;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(ta, "");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.keyboard.type(text, { delay: 12 });
}

/** DOM 结构快照:一次 evaluate 取全部结构事实(避免多次往返与时序漂移)。 */
/** 等绿晕态与 goal-bar 的 active 相位收敛一致(不变量:绿晕 === bar存在 && phase===active)。
 *  绿晕经 goal:state scoped channel 跨组件传播,而 goal 广播是「值变化」effect 驱动
 *  (比 setGoal 晚一个渲染周期)+ timeline 重渲染又一周期——瞬时快照会偶发抢在绿晕落定前
 *  (goal-command.e2e 实测间歇失败)。等这个不变量成立再快照,自适应所有阶段(设/切/停/删)。
 *  人眼几十 ms 无感,是探针赌固定时序的问题(skill §3.4),不是产品 bug。 */
async function waitAccentSettled() {
  await page.waitForFunction(() => {
    const bar = document.querySelector("[data-goal-bar]");
    const active = !!bar && bar.getAttribute("data-goal-phase") === "active";
    const ta = document.querySelector("[data-timeline-composer]");
    const pill = ta?.parentElement;
    const accent = !!pill && pill.classList.contains("pi-composer-goal") && pill.getAttribute("data-goal-active") === "true";
    return accent === active;
  }, { timeout: 6000, polling: 80 }).catch(() => {});
}

/** DOM 结构快照:先等绿晕收敛,再一次 evaluate 取全部结构事实(避免多次往返与时序漂移)。 */
const domStructure = async () => {
  await waitAccentSettled();
  return page.evaluate(() => {
  const bar = document.querySelector("[data-goal-bar]");
  const ta = document.querySelector("[data-timeline-composer]");
  const pill = ta?.parentElement ?? null;
  const barRect = bar?.getBoundingClientRect() ?? null;
  const taRect = ta?.getBoundingClientRect() ?? null;
  // bar 的祖先链(看它挂在哪个容器里)
  const chain = [];
  let el = bar;
  while (el && el !== document.body && chain.length < 8) {
    chain.push(el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""));
    el = el.parentElement;
  }
  // bar 与 ta 是否在同一个父容器(composerTop 槽与 composer 同挂 ComposerDock)
  const sameParent = !!(bar && ta && bar.parentElement && bar.parentElement.contains(ta));
  return {
    barCount: document.querySelectorAll("[data-goal-bar]").length,
    barText: bar?.innerText ?? null,
    barPhase: bar?.getAttribute("data-goal-phase") ?? null,
    barAboveComposer: !!(barRect && taRect && barRect.bottom <= taRect.top + 1),
    barAncestorChain: chain,
    barSharesParentWithComposer: sameParent,
    pillHasGoalClass: !!pill?.classList.contains("pi-composer-goal"),
    pillGoalActive: pill?.getAttribute("data-goal-active") ?? null,
    taHasGoalClass: !!ta?.classList.contains("pi-composer-goal"),   // 绿晕该在药丸不在输入框本体
    sendErrorCount: document.querySelectorAll("[data-goal-send-error]").length,
    // 幽灵节点:页面里还有没有别的会话的目标文本
    bodyHasA: document.body.innerText.includes("结构审查目标甲"),
  };
  });
};

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-sidebar-style]", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ── ① 无目标时的结构:目标条节点不存在(不是隐藏),composerTop 槽不占位 ──
  await openSession(NAME_A, MARK_A);
  let d = await domStructure();
  ok(d.barCount === 0, "① 无目标时 [data-goal-bar] 节点数为 0(卸载而非隐藏)", d.barCount);
  ok(d.pillHasGoalClass === false, "① 无目标时药丸不挂 pi-composer-goal", d.pillHasGoalClass);
  ok(d.taHasGoalClass === false, "① 绿晕不挂在输入框本体(应在药丸层)", d.taHasGoalClass);
  await shot("1-no-goal");

  // ── ② 设目标后的结构:唯一一个目标条、在输入框上方、与输入框同容器、相位锚点正确 ──
  await typeIntoComposer(`/goal ${GOAL_A}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction((o) => document.body.innerText.includes(o), { timeout: 8000, polling: 150 }, GOAL_A);
  d = await domStructure();
  ok(d.barCount === 1, "② 目标条节点恰好 1 个(composerTop 槽不重复挂载)", d.barCount);
  ok(d.barAboveComposer === true, "② 目标条位于输入框**上方**(bar.bottom ≤ ta.top)", { above: d.barAboveComposer });
  ok(d.barSharesParentWithComposer === true, "② 目标条与输入框同挂一个容器(ComposerDock:composerTop 槽 + composer)", d.barSharesParentWithComposer);
  ok(d.barPhase === "active", "② data-goal-phase=active", d.barPhase);
  ok(d.pillHasGoalClass === true, "② active 时药丸挂 pi-composer-goal(绿晕在药丸层)", d.pillHasGoalClass);
  ok(d.pillGoalActive === "true", "② data-goal-active=true(锚点与 class 双通道一致)", d.pillGoalActive);
  ok(d.taHasGoalClass === false, "② 绿晕类不在输入框本体(职责在药丸,不重复挂)", d.taHasGoalClass);
  await shot("2-goal-active");

  // 祖先链留证(结构审查的产物:目标条挂在哪个容器下)
  console.log(`    目标条祖先链: ${d.barAncestorChain.join(" < ")}`);

  // ── ③ 切会话后的结构:目标条节点整体消失(不是残留隐藏)、绿晕类撤除、无幽灵文本 ──
  await openSession(NAME_B, MARK_B);
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  d = await domStructure();
  ok(d.barCount === 0, "③ 切到乙后目标条节点数为 0(整体卸载,无幽灵节点)", d.barCount);
  ok(d.barText === null, "③ 无残留目标条文本", d.barText);
  ok(d.pillHasGoalClass === false, "③ 乙会话药丸绿晕类已撤除", d.pillHasGoalClass);
  ok(d.pillGoalActive === null, "③ 乙会话 data-goal-active 属性已移除(不是留 false)", d.pillGoalActive);
  ok(d.bodyHasA === false, "③ 页面全文不含甲的目标文本(无幽灵渲染)", d.bodyHasA);
  ok(d.sendErrorCount === 0, "③ 无失败标记残留", d.sendErrorCount);
  await shot("3-switched-clean");

  // ── ④ 切回甲:结构完整复活(节点数仍恰好 1,不叠加) ──
  await openSession(NAME_A, MARK_A);
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  d = await domStructure();
  ok(d.barCount === 1, "④ 切回甲后目标条恰好 1 个(不叠加成 2 个)", d.barCount);
  ok(d.barPhase === "active", "④ 相位仍是 active", d.barPhase);
  ok(d.barAboveComposer === true, "④ 复活后仍在输入框上方", d.barAboveComposer);
  ok(d.pillHasGoalClass === true, "④ 复活后绿晕回归", d.pillHasGoalClass);
  await shot("4-back-structure-intact");

  // ── ⑤ 暂停态的结构:相位锚点翻转、绿晕撤除、节点仍在(不是消失) ──
  await clickEl('[data-goal-action="pause"]');   // r236：按稳定锚点
  // r236：按稳定锚点定位（此前 '[title="恢复"]' 是语言绑定的；data-goal-phase 见 goal-bar.tsx）
  await page.waitForFunction(() => !!document.querySelector('[data-goal-phase="paused"]'), { timeout: 6000, polling: 150 });
  d = await domStructure();
  ok(d.barCount === 1, "⑤ 暂停后目标条节点仍在(paused 是相位,不是卸载)", d.barCount);
  ok(d.barPhase === "paused", "⑤ data-goal-phase=paused", d.barPhase);
  ok(d.pillHasGoalClass === false, "⑤ 暂停后绿晕撤除(只有 active 才着色)", d.pillHasGoalClass);
  await shot("5-paused");

  // ── ⑥ 删除后的结构:节点归零、绿晕归零 ──
  await clickEl('[title="关闭目标"]');
  await page.waitForFunction(() => !document.querySelector("[data-goal-bar]"), { timeout: 8000, polling: 150 });
  d = await domStructure();
  ok(d.barCount === 0, "⑥ 删除后目标条节点归零", d.barCount);
  ok(d.pillHasGoalClass === false, "⑥ 删除后绿晕归零", d.pillHasGoalClass);
  ok(d.bodyHasA === false, "⑥ 删除后页面无该目标文本", d.bodyHasA);
  await shot("6-cleared");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项 DOM 结构断言全部通过(目标条位置/唯一性/相位锚点/绿晕层次/无幽灵节点)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  try {
    await shot("failure");
    const diag = await domStructure().catch(() => null);
    if (diag) console.error("DOM 结构现场:", JSON.stringify(diag, null, 2));
  } catch { /* 诊断失败不掩盖原因 */ }
  await killApp(app).catch(() => {});
  console.error(`诊断截图保留: ${shotsDir}`);
  process.exit(1);
}
