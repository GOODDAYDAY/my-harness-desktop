#!/usr/bin/env node
// pi 真实内核 e2e —— 真实 pi 内核 + 真实模型(apps-studio 路由 + 真实 apiKey) + 真实 LLM 调用。
// 不用 minimal echo:发真实消息、等真实回复(非 echo 占位)、验 header.kernel=pi + 会话落 .pi/。
// 用法: npm run build && node scripts/demo/pi-smoke.e2e.mjs [--port 9350] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9350" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// 种 lastCwd 指向项目目录,composer 才就绪(否则停在「从左栏打开一个文件夹开始」)。
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

// 从隔离 HOME 的 models.json 读真实默认模型(provider + modelId + 显示名)。
const modelsPath = join(home, ".pi", "agent", "models.json");
const cfg = JSON.parse(readFileSync(modelsPath, "utf-8"));
let defaultModel = null;
for (const [provider, pc] of Object.entries(cfg?.providers ?? {})) {
  const m = pc?.models?.[0];
  if (m?.id) { defaultModel = { provider, modelId: m.id, name: m.name ?? m.id }; break; }
}
if (!defaultModel) throw new Error(`models.json 无可用模型: ${modelsPath}`);

let app;
try {
  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18464" }, timeoutMs: 90000 });
  const page = app.page;
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  ok(true, "app 拉起,composer 就绪");

  // 打开模型下拉。
  const triggerRect = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg"));
    const trigger = btns.find((b) => {
      const t = (b.textContent || "").trim();
      return t.length > 2 && !/^(off|minimal|low|medium|high|xhigh)$/i.test(t);
    });
    if (!trigger) return null;
    const r = trigger.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!triggerRect) throw new Error("未找到模型下拉触发器");
  await page.mouse.click(triggerRect.x, triggerRect.y);
  await page.waitForSelector("[role='menu']", { timeout: 4000 }).catch(() => {});
  ok(true, "模型下拉已打开");

  // 点 pi 内核 TAB(§多内核才渲染 TAB;单内核时 pi 唯一、模型直接铺开,无 TAB 可点)。
  const tabRect = await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    const tab = [...(menu?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().toLowerCase() === "pi");
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (tabRect) {
    await page.mouse.click(tabRect.x, tabRect.y);
    ok(true, "已点击 pi 内核 TAB");
  } else {
    ok(true, "单内核无 TAB,pi 模型直接铺开");
  }

  // 真 app 守卫:日常态没有 minimal —— 它是**测试专用插件**(test-plugins/),生产扫描根里没有它,
  // 本脚本也不种它(见 lib/test-plugins.mjs)。
  // 本 e2e **不种测试专用插件**（test-plugins/）→ 装载清单 = [pi, dsh] → 模型下拉的内核 TAB
  // **不得**出现 minimal。与 minimal-smoke(设了开关 → minimal 模型在场)互为对照两面。
  const tabTexts = await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    return [...(menu?.querySelectorAll("button") ?? [])]
      .map((b) => (b.textContent || "").trim().toLowerCase())
      .filter((x) => x.length > 0 && x.length <= 12);
  });
  ok(!tabTexts.includes("minimal"), `日常态无 minimal 内核(下拉里无 minimal TAB;实际 TAB=[${tabTexts.join(",")}])`);
  // 更强的正面信号:minimal 的模型项(Minimal Echo)不得出现在清单里。
  // 只断 TAB 不够——本 e2e 的基础设施不带 dsh 安装,可能一个 TAB 都不渲染(TAB=[]),
  // 「没有 minimal TAB」就退化成恒真;模型项缺席才是"这个内核没装载"的用户可见证据。
  const modelTexts = await page.evaluate(() =>
    [...document.querySelectorAll("[role^='menuitem']")].map((el) => (el.textContent || "")));
  ok(!modelTexts.some((t) => /minimal/i.test(t)), `日常态无 minimal:模型清单无 Minimal 项(实际 ${modelTexts.length} 项)`);

  // 选真实模型(按显示名匹配)。
  const itemRect = await page.evaluate((name) => {
    const item = [...document.querySelectorAll("[role^='menuitem']")].find((el) =>
      (el.textContent || "").includes(name) && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, defaultModel.name);
  if (!itemRect) throw new Error(`模型项不可点: ${defaultModel.name}`);
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  ok(true, `已选 pi 真实模型 ${defaultModel.provider}/${defaultModel.modelId}`);

  // 发真实消息(真实键盘)→ 真实 LLM 调用。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("用一句话介绍你自己");
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label^='发送']") || document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!sendRect) throw new Error("未找到发送按钮");
  await page.mouse.click(sendRect.x, sendRect.y);

  // 真实 LLM 回复:等「停止」起跑再消失(真实生成需更长时间)。
  await page.waitForSelector("[data-composer-stop]", { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: 120000, polling: 1000 }).catch(() => {});
  const replied = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => {
      const t = (el.textContent || "").trim();
      return t.length > 0 && !t.startsWith("[minimal echo]") && !t.startsWith("[dsh echo]");
    }),
    { timeout: 120000, polling: 1000 },
  ).then(() => true).catch(() => false);
  ok(replied, "时间线出现真实 LLM 回复(非 echo 占位)");

  // 文件对应守卫:中立层 header.kernel=pi + 会话落 .pi/agent/sessions/。
  const neutralDir = join(home, ".my-harness-desktop-dev", "sessions");
  const headers = readdirSync(neutralDir).filter((f) => f.endsWith(".header.json"));
  const latestHeader = headers.sort().map((f) => JSON.parse(readFileSync(join(neutralDir, f), "utf-8"))).pop();
  ok(latestHeader?.header?.kernel === "pi", "中立层 header.kernel = pi");
  const piDir = join(home, ".pi", "agent", "sessions");
  const piFiles = existsSync(piDir) ? readdirSync(piDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")) : [];
  ok(piFiles.length > 0, "pi 会话文件落在 .pi/agent/sessions/");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(pi 真实内核 + 真实 LLM)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (app) await killApp(app).catch(() => {});
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(1);
}
