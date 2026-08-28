#!/usr/bin/env node
// /goal 真实 DOM e2e —— 拉起 out/ 构建产物(隔离 HOME + CDP),在真实输入框敲 /goal,
// 逐步断言 DOM 状态;全部通过 → exit 0,任一失败 → exit 1 并留诊断截图。
//
// 用法:
//   npm run build && node scripts/demo/goal-command.e2e.mjs [--port 9333] [--keep]
//
// 覆盖(与 jsdom e2e 同语义的实机版;每次交互都是真实鼠标/键盘事件):
//   ① 敲 / → 斜杠弹窗列出 /goal + cmd 徽标(插件命令进弹窗的证明帧)
//   ② /goal <目标> 回车 → 目标条出现 + 轮次 1/256 + 输入框清空 + 文本未进会话(被拦截)
//   ③ 点「停止」→ paused(恢复按钮 + 警告色边框)
//   ④ 点轮次按钮 → 编辑输入框 → 键入新目标回车 → 目标条更新(删改停之「改」)
//   ⑤ /goal resume 回车 → 恢复 + 即时装弹(轮次 2/256)
//   ⑥ /goal stop 回车 → 再暂停
//   ⑦ 点垃圾桶 → 目标条从 DOM 消失(删改停之「删」)
//   ⑧ 裸 /goal 回车 → 发送被吞(输入框清空、无目标条;系统通知是 OS 级不进 DOM)
//
// 确定性:不种会话 → currentSessionPath=null → armIfIdle 的续跑 prompt 在
// 服务端以「会话未启动」显式拒绝、控制器静默吞掉——零真实回合、零 token、无竞态。
// 模型清单保留(真实 models.json)只为 composer 中段(composerStats/GoalBar)渲染。
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { loadScenario, applySeed } from "./lib/seed/engine.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "9333" },
    keep: { type: "boolean", default: false },
  },
});
const PORT = Number(args.port);
const OBJECTIVE = "真实DOM冒烟目标";
const EDITED = "改过的新目标";

// ── 断言套件:全绿才过,任何一步失败抛错走诊断收尾 ──
let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/** 页面可见文本断言走 innerText(视觉真相):注意 JSX 的 {a}/{b} 会拆成多个文本节点,
 *  按单节点 textContent 匹配 "1/256" 必漏——innerText 拼接才是用户看到的样子。 */
async function visibleText(page, text) {
  return page.evaluate((t) => document.body.innerText.includes(t), text);
}

async function selCount(page, sel) {
  return page.evaluate((s) => document.querySelectorAll(s).length, sel);
}

async function inputValue(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return el && "value" in el ? el.value : null;
  }, sel);
}

/** 目标横幅(composerTop 槽)是否在输入框**上方**:横幅底边 ≤ 文本域顶边。 */
async function goalBarAboveComposer(page) {
  return page.evaluate(() => {
    const bar = document.querySelector("[data-goal-bar]");
    const ta = document.querySelector("[data-timeline-composer]");
    if (!bar || !ta) return false;
    return bar.getBoundingClientRect().bottom <= ta.getBoundingClientRect().top + 1;
  });
}

/** 输入框药丸是否挂 goal 生效着色(类 + 锚点同验)。 */
async function composerGoalAccent(page) {
  return page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const pill = ta?.parentElement;
    if (!pill) return false;
    return pill.classList.contains("pi-composer-goal") && pill.getAttribute("data-goal-active") === "true";
  });
}

/** 目标条(含指定文本的横幅)左边框样式是否含某 CSS 变量。 */
async function goalBarStyleContains(page, text, cssVar) {
  return page.evaluate(([t, v]) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.includes(t)) continue;
      let el = n.parentElement;
      while (el && el !== document.body) {
        const style = el.getAttribute?.("style") ?? "";
        if (style.includes("border-left") && style.includes("color-mix")) return style.includes(v);
        el = el.parentElement;
      }
    }
    return false;
  }, [text, cssVar]);
}

async function clickSel(page, sel) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  if (!box) throw new Error(`点击目标不存在: ${sel}`);
  await page.mouse.click(box.x, box.y);
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 5000 }).catch(() => {});
}

async function typeIntoComposer(page, text) {
  await clickSel(page, "[data-timeline-composer]");
  await page.keyboard.type(text, { delay: 12 });
}

/** 轮询断言(真实渲染节奏不赌固定 sleep);fnArgs 透传给页面内函数。 */
async function waitFor(page, fn, label, timeoutMs = 8000, ...fnArgs) {
  await page.waitForFunction(fn, { timeout: timeoutMs, polling: 100 }, ...fnArgs);
  ok(true, label);
}

// ── 主流程 ──
if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

await assertPortFree(PORT);
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
const shotsDir = join(runRoot, "e2e-shots");
mkdirSync(shotsDir, { recursive: true });

console.log(`隔离 HOME: ${home}`);
console.log(`截图: ${shotsDir}(--keep 保留整根)`);
const scenarioDir = join(HERE, "scenarios", "goal-command");
const bundle = await loadScenario(scenarioDir, "zh-CN");
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
applySeed(ctx, scenarioDir, bundle.spec, bundle.dict);

// 首启隔离 HOME 冷启动偏慢(内核探测等;实测 CDP 就绪可到 25s)→ 放宽到 90s。
const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home }, timeoutMs: 90000 });
const page = app.page;
let shotN = 0;
async function shot(name) {
  shotN += 1;
  await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) });
}

try {
  // 就绪:侧栏 + 输入框挂载(插件已装配,含 composerCommands 收集)
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-sidebar-style]", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ① 敲 / → 弹窗含 /goal + cmd 徽标
  await typeIntoComposer(page, "/");
  await waitFor(
    page,
    () => document.body.innerText.includes("/goal") && document.body.innerText.includes("cmd"),
    "① 斜杠弹窗列出 /goal 与 cmd 徽标",
  );
  await shot("slash-popup");

  // ② 补全命令并回车 → 目标条出现 + 1/256 + 输入框清空 + 弹窗关闭
  await page.keyboard.type(`goal ${OBJECTIVE}`, { delay: 12 });
  await page.keyboard.press("Enter");
  await waitFor(
    page,
    (obj) => document.body.innerText.includes(obj),
    "② /goal 回车后目标条出现(客观)",
    8000,
    OBJECTIVE,
  );
  await waitFor(
    page,
    () => document.body.innerText.includes("1/256"),
    "② 轮次显示 1/256(空闲即装首轮)",
  );
  ok((await inputValue(page, "[data-timeline-composer]")) === "", "② 输入框已被拦截清空(文本未进会话)");
  ok(!(await visibleText(page, "/goal")), "② 弹窗已关闭");
  ok((await selCount(page, '[title="停止"]')) >= 1, "② active 态:停止按钮在位");
  ok((await selCount(page, "[data-goal-bar]")) === 1, "② 目标横幅在位(composerTop 槽)");
  ok(await goalBarAboveComposer(page), "② 目标横幅位于输入框上方");
  ok(await composerGoalAccent(page), "② goal 生效:输入框药丸挂绿晕着色");
  await shot("goal-set");

  // ③ 点停止 → paused 态
  await clickSel(page, '[title="停止"]');
  await waitFor(page, () => !!document.querySelector('[title="恢复"]'), "③ 点停止 → 恢复按钮出现");
  ok(await goalBarStyleContains(page, OBJECTIVE, "--color-accent-warning"), "③ 目标条转警告色边框(paused)");
  ok(!(await composerGoalAccent(page)), "③ 暂停后输入框绿晕熄灭");
  await shot("goal-paused");

  // ④ 点轮次按钮进编辑 → 键入新目标回车 → 更新
  await clickSel(page, '[title="编辑目标"]');
  await page.waitForSelector(`input[placeholder="${OBJECTIVE}"]`, { timeout: 5000 });
  ok(true, "④ 编辑输入框出现(placeholder=当前目标)");
  await clickSel(page, `input[placeholder="${OBJECTIVE}"]`);
  await page.keyboard.type(EDITED, { delay: 12 });
  await page.keyboard.press("Enter");
  await waitFor(
    page,
    (t) => document.body.innerText.includes(t),
    "④ 回车后目标条显示新目标",
    8000,
    EDITED,
  );
  await shot("goal-edited");

  // ⑤ /goal resume → active + 即时装弹(轮次推进)
  await typeIntoComposer(page, "/goal resume");
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector('[title="停止"]'), "⑤ /goal resume → 停止按钮回归(active)");
  await waitFor(
    page,
    () => document.body.innerText.includes("2/256"),
    "⑤ 恢复即装弹:轮次 2/256",
  );
  ok(await composerGoalAccent(page), "⑤ 恢复生效:输入框绿晕回归");
  await shot("goal-resumed");

  // ⑥ /goal stop → 再暂停
  await typeIntoComposer(page, "/goal stop");
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector('[title="恢复"]'), "⑥ /goal stop → 恢复按钮回归(paused)");
  ok(!(await composerGoalAccent(page)), "⑥ 再暂停:输入框绿晕再熄灭");

  // ⑦ 点垃圾桶 → 目标条从 DOM 消失
  await clickSel(page, '[title="关闭目标"]');
  await waitFor(
    page,
    (t) => !document.body.innerText.includes(t),
    "⑦ 点关闭 → 目标条从 DOM 消失",
    8000,
    EDITED,
  );
  ok((await selCount(page, '[title="停止"]')) === 0 && (await selCount(page, '[title="恢复"]')) === 0, "⑦ 停止/恢复按钮全撤");
  ok((await selCount(page, "[data-goal-bar]")) === 0, "⑦ 横幅节点撤除");
  await shot("goal-cleared");

  // ⑧ 裸 /goal(尾随空格绕开弹窗补全)→ 吞发送、无副作用
  await typeIntoComposer(page, "/goal ");
  await page.keyboard.press("Enter");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 5000 }).catch(() => {});
  ok((await inputValue(page, "[data-timeline-composer]")) === "", "⑧ 裸 /goal 被吞:输入框清空");
  ok((await selCount(page, '[title="停止"]')) === 0 && (await selCount(page, '[title="恢复"]')) === 0, "⑧ 无目标条残留");
  await shot("bare-goal");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项 DOM 断言全部通过(/goal 真实设置 + 删改停)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  try {
    await shot("failure");
    const diag = await page.evaluate(() => ({
      bodySnippet: document.body.innerText.slice(0, 400),
      composer: document.querySelector("[data-timeline-composer]")?.value ?? null,
    })).catch(() => null);
    if (diag) console.error("现场:", JSON.stringify(diag, null, 2));
  } catch { /* 诊断失败不掩盖原因 */ }
  await killApp(app).catch(() => {});
  console.error(`诊断截图保留: ${shotsDir}`);
  process.exit(1);
}
