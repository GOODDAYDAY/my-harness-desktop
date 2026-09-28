#!/usr/bin/env node
// minimal 真模型 e2e —— 隔离 HOME + 种 minimal 模型配置(指向本地 mock SSE 服务器),真 app 里验:
// 选 minimal 内核的 Mock 模型(来自 models.json)→ 发送 → 时间线出现 mock 模型的流式回复(非 echo)。
// 这是「单测 mock 服务器 + e2e echo 兜底」之间的缺口补齐:验 full path(app→shell→adapter→CLI→模型配置→mock→SSE→DOM)。
// 零真实 LLM、零外网。
// 用法: npm run build && node scripts/demo/minimal-model.e2e.mjs [--port 9352] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickPointUntil } from "./lib/interact.mjs";

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
    // usage 帧（OpenAI 在 `stream_options.include_usage` 下的形状）+ finish_reason：
    // 文档 §3.3.3 要求 message 里含 usage/stopReason，这条从"内核 → 落盘"端到端验它。
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":111,"completion_tokens":22,"total_tokens":133,"prompt_tokens_details":{"cached_tokens":7}}}\n\n');
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
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// minimal 是**测试专用内核插件**(不再随壳分发):种进隔离 HOME 的用户插件目录才会装载。
seedTestPlugins(ctx.dataRoot);
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

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18461" }, timeoutMs: 90000 });
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
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：等右键/溢出菜单展开，
  // 只为让后续对菜单项的采样稳定；菜单真没出来时，下面对**菜单项**的断言会自己红。
  await page.waitForSelector("[role='menu']", { timeout: 4000 }).catch(() => {});
  // 有界重试点击（每次重算坐标）：菜单动画未落定时一次性取的坐标会**打偏**，
  // 而"打偏"的现场与本文件下面注释里那个"点 TAB 后列表还没换"的假失败**长得一模一样**。
  // 重试的判据直接就是"Mock 项可见"，所以两种情况一起被覆盖。
  const tabClicked = await clickPointUntil(
    page,
    () => {
      const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes("Mock") && el.getBoundingClientRect().width > 0),
  );
  if (!tabClicked) throw new Error("minimal TAB 点了多次仍未让「Mock」模型项出现");
  // 必须等列表真的换成 minimal 的:点 TAB → Radix 状态更新 → 重渲染是**异步**的,
  // 立刻取样会读到**上一个内核**的列表(实测「Mock 未找到」的假失败正是这么来的:
  // dump 显示 tabs 有 minimal 但 items 全是 pi 的)。纪律见 skills §10.3.1:等待谓词 W 必须覆盖断言谓词 X。
  await page.waitForFunction(
    () => [...document.querySelectorAll("[role^='menuitem']")].some((el) => (el.textContent || "").includes("Mock")),
    { timeout: 6000, polling: 200 },
  ).catch(() => {});
  const itemRect = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role^='menuitem']")].find((el) => (el.textContent || "").includes("Mock") && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!itemRect) {
    const dump = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll("[role='menu'] button")].map((b) => (b.textContent || "").trim()).filter(Boolean),
      items: [...document.querySelectorAll("[role^='menuitem']")].map((m) => (m.textContent || "").trim().slice(0, 30)).filter(Boolean),
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

  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：两阶段收敛的第一阶段——
  // 等「停止」出现。零 token / 模型端点不可达的剧本里 streaming 可能**从不开始**，
  // 停止钮合法地不出现，所以等不到不算失败（真失败由『发送后该出现的产物』那些断言报出来）。
  await page.waitForSelector("[data-composer-stop]", { timeout: 20000 }).catch(() => {});
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：两阶段收敛的第二阶段——
  // 等「停止」消失（streaming 收尾）。等不到也继续：后续断言读的是终态 DOM，
  // 若仍在 streaming 会由那些断言报出来，而不是在这里静默吞掉一个『没收尾』的信号。
  await page.waitForFunction(() => !document.querySelector("[data-composer-stop]"), { timeout: 30000, polling: 500 }).catch(() => {});

  // 真模型回复(非 echo)。
  const modelText = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("这是 mock 模型的流式回复")),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(modelText, "时间线出现 mock 模型的流式回复(真模型路径,非 echo)");
  const noEcho = await page.evaluate(() => ![...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("[minimal echo]")));
  ok(noEcho, "无 echo 兜底(确实走了真模型)");

  // ── 用量端到端：内核拿到的 usage 真的落进了 minimal 会话文件 ──
  // 判据在**盘上**（内核是写穿先于发事件的），拿圆心 messageUsageOf 解析——不在测试里另写一份期望形状。
  const sessionsRoot = join(home, ".minimal", "agent", "sessions");
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const full = join(d, e.name); if (e.isDirectory()) walk(full); else if (e.name.endsWith(".jsonl")) files.push(full); } };
  walk(sessionsRoot);
  const assistant = files.flatMap((f) => readFileSync(f, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)))
    .map((e) => e.message).filter((m) => m && m.role === "assistant");
  const withUsage = assistant.find((m) => m.usage);
  ok(!!withUsage, "minimal 会话文件里的 assistant 消息带 usage（文档 §3.3.3 的形状要求，内核此前整帧丢弃）");
  ok(withUsage?.usage?.totalTokens === 133 && withUsage?.usage?.input === 111 && withUsage?.usage?.cacheRead === 7,
    `usage 数字与 mock 发的帧一致（实际 ${JSON.stringify(withUsage?.usage)}）`);
  ok(withUsage?.stopReason === "stop", `finish_reason 落成 stopReason（实际 ${withUsage?.stopReason}）`);

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
