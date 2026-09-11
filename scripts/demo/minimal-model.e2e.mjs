#!/usr/bin/env node
// minimal 真模型 e2e —— 隔离 HOME + 种 minimal 模型配置(指向本地 mock SSE 服务器),真 app 里验:
// 选 minimal 内核的 Mock 模型(来自 models.json)→ 发送 → 时间线出现 mock 模型的流式回复(非 echo)。
// 这是「单测 mock 服务器 + e2e echo 兜底」之间的缺口补齐:验 full path(app→shell→adapter→CLI→模型配置→mock→SSE→DOM)。
// 零真实 LLM、零外网。
// 用法: npm run build && node scripts/demo/minimal-model.e2e.mjs [--port 9352] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9352" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// mock SSE 服务器:POST /v1/chat/completions → 两段流式 delta。
const mockServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write('data: {"choices":[{"delta":{"content":"这是 mock"}}]}\n\n');
  setTimeout(() => {
    res.write('data: {"choices":[{"delta":{"content":" 模型的流式回复"}}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  }, 60);
});
await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const addr = mockServer.address();
const baseURL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

// 种 minimal 模型配置(§4.9):providers + default 指向 mock 服务器,apiKey 落凭证文件。
const minimalAgentDir = join(home, ".minimal", "agent");
mkdirSync(minimalAgentDir, { recursive: true });
writeFileSync(join(minimalAgentDir, "models.json"), JSON.stringify({
  providers: [{ id: "mock", baseURL, models: [{ id: "mock-model", name: "Mock" }] }],
  default: { provider: "mock", model: "mock-model" },
}));
writeFileSync(join(minimalAgentDir, ".credentials.json"), JSON.stringify({ mock: "sk-test" }));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18461", MHD_ENABLE_KERNELS: "minimal" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 选 Minimal Echo(与 minimal-smoke 同款 trusted-click 配方)。
  const triggerRect = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg"));
    const trigger = btns.find((b) => { const t = (b.textContent || "").trim(); return t.length > 2 && !/^(off|minimal|low|medium|high|xhigh)$/i.test(t); });
    if (!trigger) return null;
    const r = trigger.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(triggerRect.x, triggerRect.y);
  await page.waitForSelector("[role='menu']", { timeout: 4000 }).catch(() => {});
  const tabRect = await page.evaluate(() => {
    const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(tabRect.x, tabRect.y);
  // 必须等列表真的换成 minimal 的:点 TAB → Radix 状态更新 → 重渲染是**异步**的,
  // 立刻取样会读到**上一个内核**的列表(实测「Mock 未找到」的假失败正是这么来的:
  // dump 显示 tabs 有 minimal 但 items 全是 pi 的)。纪律见 skills §10.3.1:等待谓词 W 必须覆盖断言谓词 X。
  await page.waitForFunction(
    () => [...document.querySelectorAll("[role='menuitem']")].some((el) => (el.textContent || "").includes("Mock")),
    { timeout: 6000, polling: 200 },
  ).catch(() => {});
  const itemRect = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role='menuitem']")].find((el) => (el.textContent || "").includes("Mock") && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!itemRect) {
    const dump = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll("[role='menu'] button")].map((b) => (b.textContent || "").trim()).filter(Boolean),
      items: [...document.querySelectorAll("[role='menuitem']")].map((m) => (m.textContent || "").trim().slice(0, 30)).filter(Boolean),
    }));
    throw new Error(`「Mock」模型项未找到;下拉现场: ${JSON.stringify(dump)}`);
  }
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});

  // 发送。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("调模型");
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label^='发送']") || document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(sendRect.x, sendRect.y);

  await page.waitForSelector("[aria-label*='停止']", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 30000, polling: 500 }).catch(() => {});

  // 真模型回复(非 echo)。
  const modelText = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("这是 mock 模型的流式回复")),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(modelText, "时间线出现 mock 模型的流式回复(真模型路径,非 echo)");
  const noEcho = await page.evaluate(() => ![...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("[minimal echo]")));
  ok(noEcho, "无 echo 兜底(确实走了真模型)");

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条)`);

  await killApp(app);
  await new Promise((r) => mockServer.close(() => r()));
  console.log(`\n✅ PASS: ${passed} 项断言(minimal 真模型 e2e,零真实 LLM)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  await new Promise((r) => mockServer.close(() => r()));
  process.exit(1);
}
