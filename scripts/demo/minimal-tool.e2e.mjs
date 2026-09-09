#!/usr/bin/env node
// minimal 工具卡 DOM e2e —— 隔离 HOME + 种模型配置(指向本地 mock SSE 服务器),真 app 里验:
// 发送 → 模型调 read 工具 → 工具执行读文件 → 时间线出现工具卡(工具名 + 结果)。
// 这是「工具回环」的 DOM 级验证(单测只验事件流,这里验真实时间线渲染)。零真实 LLM、零外网。
// 用法: npm run build && node scripts/demo/minimal-tool.e2e.mjs [--port 9354] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9354" }, keep: { type: "boolean", default: false } } });

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
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, "note.txt"), "工具读取成功", "utf-8");
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

// mock 服务器:第一轮返回 read 工具调用,第二轮(有 tool 消息)返回最终文本。
const notePath = join(projectDir, "note.txt");
const mockServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const hasTool = (parsed.messages ?? []).some((m) => m.role === "tool");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (!hasTool) {
      const args = JSON.stringify({ path: notePath });
      res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":${JSON.stringify(args)}}}]}}]}\n\n`);
      res.write("data: [DONE]\n\n");
    } else {
      res.write('data: {"choices":[{"delta":{"content":"读到了"}}]}\n\n');
      res.write("data: [DONE]\n\n");
    }
    res.end();
  });
});
await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const addr = mockServer.address();
const baseURL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;

const minimalAgentDir = join(home, ".minimal", "agent");
mkdirSync(minimalAgentDir, { recursive: true });
writeFileSync(join(minimalAgentDir, "models.json"), JSON.stringify({
  providers: [{ id: "mock", baseURL, models: [{ id: "mock-model", name: "Mock" }] }],
  default: { provider: "mock", model: "mock-model" },
}));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18463" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 选 minimal 的 Mock 模型(与 minimal-model 同款 trusted-click 配方)。
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
  const itemRect = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role='menuitem']")].find((el) => (el.textContent || "").includes("Mock") && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});

  // 发送。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("读一下 note.txt");
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label^='发送']") || document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(sendRect.x, sendRect.y);
  await page.waitForSelector("[aria-label*='停止']", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 30000, polling: 500 }).catch(() => {});

  // 工具卡:时间线出现工具 args(note.txt 文件路径)+ 回环完成后的最终文本「读到了」。
  // (工具名 read 是图标非文本、结果是折叠态,故断言 args + 最终文本,不按工具名/结果断言)
  const toolCard = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("note.txt")),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(toolCard, "时间线出现工具卡(note.txt 工具 args 渲染)");
  const result = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("读到了")),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(result, "工具回环完成(最终文本「读到了」渲染)");

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条)`);

  await killApp(app);
  await new Promise((r) => mockServer.close(() => r()));
  console.log(`\n✅ PASS: ${passed} 项断言(minimal 工具卡 DOM,零真实 LLM)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  await new Promise((r) => mockServer.close(() => r()));
  process.exit(1);
}
