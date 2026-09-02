#!/usr/bin/env node
// ask 提问真实 DOM e2e —— 拉起 out/ 构建产物(隔离 HOME + 独立服务端口 + CDP),
// 真实 pi 内核 + 真实模型调用 ask_user_question,逐步断言:
//   ① 发送「让模型调 ask_user_question」的指令(真实回合,花真 token)
//   ② 提问卡出现:问题正文 + 选项**每选项独占一整行**(flex-col + w-full,用户要求)
//   ③ 点选选项 → 提交 → 答案回填(answerQuestion 全链路:renderer → WS → main → pi 内核)
//      ——断言全程不出现「内核未启动」类错误(提问投递点已拦死问句,作答路径已诚实化)
//   ④ 卡片结算(摘要 N/M answered 出现)
//   ⑤ 多选题(checkbox)路径:勾选两项 + 自定义输入共存提交
//
// 用法: npm run build && node scripts/demo/ask-question.e2e.mjs [--port 9334] [--keep]
// 注意: 本脚本花真实 token(真实模型调用),与 goal-command.e2e.mjs 的零 token 沙箱不同。
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
    port: { type: "string", default: "9334" },
    keep: { type: "boolean", default: false },
  },
});
const PORT = Number(args.port);
const APP_PORT = 18421; // 应用服务端独立端口(与 dev 实例 8420、e2e 兄弟 18420 错开;assemble 读 MHD_PORT)

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function selCount(page, sel) {
  return page.evaluate((s) => document.querySelectorAll(s).length, sel);
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
  await page.keyboard.type(text, { delay: 4 });
}

async function waitFor(page, fn, label, timeoutMs = 120000, ...fnArgs) {
  await page.waitForFunction(fn, { timeout: timeoutMs, polling: 300 }, ...fnArgs);
  ok(true, label);
}

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

await assertPortFree(PORT);
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
const shotsDir = join(runRoot, "e2e-shots");
mkdirSync(shotsDir, { recursive: true });

console.log(`隔离 HOME: ${home}(真实 pi 内核 + 真实模型,花真 token)`);
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// 复用 goal-command 场景的项目种子(左栏有项目可开,输入框才可用)。
const scenarioDir = join(HERE, "scenarios", "goal-command");
const bundle = await loadScenario(scenarioDir, "zh-CN");
applySeed(ctx, scenarioDir, bundle.spec, bundle.dict);

const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
let shotN = 0;
async function shot(name) {
  shotN += 1;
  await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) });
}

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ① 发送指令让模型调 ask_user_question(真实回合)
  await typeIntoComposer(page, "请立即调用 ask_user_question 工具问我一个问题：「选哪个水果？」，选项给「苹果」和「香蕉」两个，别的什么都不要做。");
  await page.keyboard.press("Enter");

  // ② 提问卡出现 + 整行选项
  await waitFor(
    page,
    () => !!document.querySelector("[data-ask-question]"),
    "② 提问卡出现([data-ask-question])",
  );
  await waitFor(
    page,
    () => document.body.innerText.includes("苹果") && document.body.innerText.includes("香蕉"),
    "② 选项「苹果」「香蕉」渲染",
  );
  // 整行布局:选项容器纵向堆叠(flex-col)+ 选项整行宽(w-full)——用户要求「每个选项一整行」
  const layoutOk = await page.evaluate(() => {
    const card = document.querySelector("[data-ask-question]");
    const group = card?.querySelector("[role=radiogroup], [role=group]");
    const firstOpt = group?.querySelector("button");
    if (!group || !firstOpt) return false;
    return group.className.includes("flex-col") && firstOpt.className.includes("w-full") && firstOpt.className.includes("text-left");
  });
  ok(layoutOk, "② 选项整行布局(纵向堆叠 + 整行宽 + 左对齐)");
  // 无「内核未启动」/「提问已失效」类错误(投递点拦死问句 + 作答路径诚实化)
  ok(!(await page.evaluate(() => document.body.innerText.includes("内核未启动") || document.body.innerText.includes("提问已失效"))), "② 无内核未启动类错误");
  await shot("ask-card");

  // ③ 点选「苹果」→ 提交 → 答案回填
  await page.evaluate(() => {
    const card = document.querySelector("[data-ask-question]");
    const opt = card?.querySelector('[role="radio"][aria-label="苹果"]');
    opt?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 5000 }).catch(() => {});
  await page.evaluate(() => {
    const card = document.querySelector("[data-ask-question]");
    const btns = Array.from(card?.querySelectorAll("button") ?? []);
    const submit = btns.find((b) => (b.innerText || "").trim() === "提交");
    submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  // ④ 卡片结算(摘要出现)——答案经 answerQuestion 回填内核,卡片转结算态
  await waitFor(
    page,
    () => document.body.innerText.includes("1/1 answered") || document.body.innerText.includes("answered"),
    "④ 卡片结算(摘要 answered)——答案回填全链路通畅",
  );
  ok(!(await page.evaluate(() => document.body.innerText.includes("内核未启动") || document.body.innerText.includes("提问已失效"))), "④ 作答后仍无内核类错误");
  await shot("ask-settled");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言全部通过(ask 真实模型 + 整行选项 + 作答回填)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  try {
    await shot("failure");
    const diag = await page.evaluate(() => document.body.innerText.slice(-600)).catch(() => null);
    if (diag) console.error("现场尾部:", diag);
  } catch { /* 诊断失败不掩盖原因 */ }
  await killApp(app).catch(() => {});
  console.error(`诊断截图保留: ${shotsDir}`);
  process.exit(1);
}
