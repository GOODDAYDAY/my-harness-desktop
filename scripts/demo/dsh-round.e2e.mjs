#!/usr/bin/env node
// dsh 真实回合 e2e（**零 token**）—— 真 dsh 内核 + 本地 mock SSE 模型，跑通一整轮发送。
//
// 为什么必须有这条：此前 dsh 侧只有"模型派发"被验过（`kernel-dispatch.e2e.mjs` 验的是
// setModel 路由到哪个内核 + 能力指纹），**没有一条 e2e 真的让 dsh 跑完一个回合**。
// dsh 的真实回合只能靠真 key 跑（`dsh-smoke` / `dsh-multiturn` / `dsh-credentials` 都要求
// "app 已运行 + 真凭证"），于是：
//   · 用户诉求 #16「一定要有 pi 内核和 DSH 内核的调度测试情况」在 dsh 侧只到派发为止；
//   · #20（dsh 执行时右侧请求记录）的**读侧**此前连能跑的 e2e 都没有。
// 本文件把 dsh 指向一个**本地 mock OpenAI 兼容服务**，于是整轮可以零 token 反复跑：
//   app → 壳 → DshBackend → dsh 进程（真内核、真 JSON-RPC、真会话落盘）→ mock SSE → DOM。
//
// 用法: npm run build && node scripts/demo/dsh-round.e2e.mjs [--port 9363] [--keep]

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { launchApp, killApp, assertPortFree } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline, setupDshKernel } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickPointUntil } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const args = Object.fromEntries(process.argv.slice(2).flatMap((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [[m[1], m[2] ?? true]] : [];
}));
const PORT = Number(args.port) > 0 ? Number(args.port) : 9363;
const APP_PORT = 18466;

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ── 本地 mock：OpenAI 兼容 SSE。dsh 走的是它自己的 provider 配置（api: openai-completions），
//    所以这里只实现 /chat/completions 的流式两段 delta —— 与 minimal 的 mock 同一套形状。 ──
const seen = [];
const mockServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url ?? "", auth: req.headers["authorization"] ?? "" });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // ⚠ 必须带 `finish_reason`：dsh 侧对"流结束但没有 finish_reason"判为
    // **"Stream ended without finish_reason"**（用户看到的是「生成失败」）。
    // 这是"替身的形状要真"的又一例（skills §11.12）：SSE 少一个字段，
    // 现场看着像 dsh 内核坏了，其实是 mock 不像 OpenAI。
    res.write('data: {"choices":[{"delta":{"role":"assistant","content":"这是 dsh"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":" mock 回合的回复"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 60);
  });
});
await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const addr = mockServer.address();
const mockPort = typeof addr === "object" && addr ? addr.port : 0;
const baseURL = `http://127.0.0.1:${mockPort}/v1`;

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const dsh = setupDshKernel(home, homedir());
if (!dsh.available) {
  console.error("⚠ 本机没有可用的 dsh 内核（~/.my-harness-desktop-dev/dsh 缺席）——不伪造通过，直接跳过");
  mockServer.close();
  rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
}
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

// 隔离的 dsh provider 配置：只留 mock 一个 provider，指向本地 mock，key 走 env。
// 不直接改真 settings.yaml（setupDshKernel 已经拷贝到隔离 HOME，改的是副本）。
writeFileSync(dsh.settingsPath, [
  "agent-presets:",
  "  default: standard",
  "permission:",
  "  defaultPreset: danger-full-access",
  "llm-pi-ai:",
  "  providers:",
  "    mock:",
  "      apiKeyEnv: MHD_DSH_MOCK_KEY",
  "      api: openai-completions",
  "      baseURL: " + baseURL,
  "      models:",
  "        - id: mock-dsh",
  "          name: Mock DSH",
  "          contextWindow: 100000",
  "          maxTokens: 4096",
  "",
].join("\n"));

await assertPortFree(PORT);
const app = await launchApp({
  appDir: ROOT,
  port: PORT,
  env: { HOME: home, MHD_PORT: String(APP_PORT), MHD_DSH_MOCK_KEY: "sk-mock", KERNEL_BUILD_ROOT: undefined },
  timeoutMs: 120000,
});
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 40000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 30000 });

  // 打开模型下拉 → 点 dsh 内核 TAB（多内核才有 TAB，条件式）→ 选 Mock DSH。
  const triggerRect = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const trigger = [...scope.querySelectorAll("button")].find((b) => {
      const t = (b.textContent || "").trim();
      return b.querySelector("svg") && t.length > 2 && !/^(off|minimal|low|medium|high|xhigh)$/i.test(t);
    });
    if (!trigger) return null;
    const r = trigger.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!triggerRect) throw new Error("未找到模型下拉触发器");
  await page.mouse.click(triggerRect.x, triggerRect.y);
  await page.waitForSelector("[role='menu']", { timeout: 6000 }).catch(() => {});
  // 多内核时下拉按内核分 TAB。TAB 点击用**有界重试**（菜单动画未落定会打偏），
  // 重试判据就是"目标模型项可见"。
  const hasTab = await page.evaluate(() => [...document.querySelectorAll("[role='menu'] button")].some((b) => (b.textContent || "").trim().toLowerCase() === "dsh"));
  const itemReady = hasTab
    ? await clickPointUntil(
        page,
        () => {
          const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === "dsh");
          if (!tab) return null;
          const r = tab.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        },
        () => [...document.querySelectorAll("[role='menuitem']")].some((el) => (el.textContent || "").includes("Mock DSH") && el.getBoundingClientRect().width > 0),
      )
    : await page.waitForFunction(
        () => [...document.querySelectorAll("[role='menuitem']")].some((el) => (el.textContent || "").includes("Mock DSH")),
        { timeout: 15000, polling: 300 },
      ).then(() => true).catch(() => false);
  ok(itemReady, "dsh 的模型（Mock DSH，来自隔离 settings.yaml）出现在下拉里");
  const itemRect = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role='menuitem']")].find((el) => (el.textContent || "").includes("Mock DSH") && el.getBoundingClientRect().width > 0);
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 8000 }).catch(() => {});
  const composerModel = await page.evaluate(() => document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "");
  ok(composerModel.startsWith("dsh:"), `composer 固定到 dsh 的模型（实际 ${composerModel}）`);

  // 真实发送。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("你好 dsh");
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label^='发送']") || document.querySelector("button[aria-label*='发送']");
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(sendRect.x, sendRect.y);
  await page.waitForSelector("[aria-label*='停止']", { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 90000, polling: 500 }).catch(() => {});

  const replied = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("这是 dsh")),
    { timeout: 60000, polling: 300 },
  ).then(() => true).catch(() => false);
  if (!replied) {
    const diag = await page.evaluate(() => ({
      messages: [...document.querySelectorAll("[data-message-id]")].map((el) => (el.textContent || "").replace(/\s+/g, " ").slice(0, 70)),
      model: document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "",
    }));
    console.error("  诊断(页面):", JSON.stringify(diag));
    console.error("  页面报错:", JSON.stringify(consoleTail.slice(0, 2)));
    console.error("  mock 收到的请求:", JSON.stringify(seen.slice(0, 2)));
  }
  ok(replied, "dsh 真回合：mock 模型的流式回复进了时间线（真内核、真 JSON-RPC、真落盘）");
  ok(seen.length > 0, `mock 服务真的被 dsh 调到了（${seen.length} 次请求）`);
  ok(/^Bearer sk-mock$/.test(String(seen[0]?.auth ?? "")), `apiKeyEnv 的 key 被带上（实际 ${seen[0]?.auth}）`);

  // 落盘对账（数据层）：中立层 header.kernel=dsh；dsh 会话根下出现该会话。
  await waitForDomIdle(page, { quietMs: 1200, timeoutMs: 15000 }).catch(() => {});
  const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
  const headers = [];
  for (const f of readdirSync(sessionsDir)) {
    if (f.endsWith(".header.json")) headers.push(JSON.parse(readFileSync(join(sessionsDir, f), "utf-8")));
  }
  const dshHeader = headers.find((h) => h.header?.kernel === "dsh");
  ok(!!dshHeader, "中立层 header.kernel = dsh（会话归属正确）");

  // ── #20 的**端到端**守卫：dsh 执行时右侧「请求记录」要有记录 ──
  // 此前这条链路的守卫只到两半：写侧（扩展的 6 条流程测试）与读侧（面板刷新的 5 条 DOM 测试），
  // **没有一条 e2e 把"dsh 真跑一轮 → 盘上真有记录"串起来**——而用户报的正是这个整体症状
  // 「dsh 内核执行的时候右侧的请求记录就没有记录了」。现在 dsh 能零 token 跑真回合了，这条能补上。
  const logDir = join(projectDir, ".my-harness-desktop", "llm-logs");
  const readLogs = () => {
    try {
      return readdirSync(logDir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => readFileSync(join(logDir, f), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
    } catch { return []; }
  };
  // 记录由 dsh 侧扩展写、**回合边界**才结算 response（§8.2 的时序），所以给一点收敛余量（事件驱动轮询）。
  let lines = [];
  for (let i = 0; i < 40 && lines.filter((l) => l.kind === "response").length === 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    lines = readLogs();
  }
  const reqs = lines.filter((l) => l.kind === "request");
  const resps = lines.filter((l) => l.kind === "response");
  ok(reqs.length > 0, `dsh 执行留下了 request 记录（${reqs.length} 条，目录 ${logDir}）`);
  ok(resps.length > 0, "response 记录也落了盘（dsh 的结算在回合边界，不是 messageEnd —— 这正是 #20 的根因时序）");
  // 判据要**照着契约写**，别自己加码：`ResponseLine.status` 是可选的
  // （扩展侧注释："连接级失败无 status(after_provider_response 未触发)"），
  // dsh 的结算路径本来就不一定带状态码。面板对 undefined 的渲染是 "—"，
  // 而不是「未返回」——「未返回」的判据是 **response 行为 null（孤儿）**。
  // 我第一版断言"必须有数字状态码"，那是我发明的强条件，系统从没承诺过（假红）。
  const paired = reqs.every((q) => resps.some((r) => r.seq === q.seq));
  ok(paired, "每条 request 都有配对的 response（状态已从「未返回」流转，不是孤儿）");
  ok(
    resps.every((r) => r.status === undefined || typeof r.status === "number"),
    "带状态码时它必须是数字（形状正确）",
  );
  // ── #20 的**用户可见**判据：右侧面板里真的显示出这条记录 ──
  // 上面验的是"盘上有没有"；用户报的是"右侧的请求记录就没有记录了"——
  // 盘上有、面板不显示，症状对用户是一模一样的。所以必须走到面板 DOM。
  await page.keyboard.down("Meta"); await page.keyboard.press("j"); await page.keyboard.up("Meta");
  const tabReady = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-sidepanel-style] button[aria-label]")].some((b) => (b.getAttribute("aria-label") || "").includes("请求记录")),
    { timeout: 15000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(tabReady, "右面板出现「请求记录」页签");
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("[data-sidepanel-style] button[aria-label]")].find((x) => (x.getAttribute("aria-label") || "").includes("请求记录"));
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const rowShown = await page.waitForFunction(
    () => document.body.innerText.includes("#1"),
    { timeout: 15000, polling: 300 },
  ).then(() => true).catch(() => false);
  const panelText = await page.evaluate(() => document.body.innerText);
  if (!panelText.includes("#1")) {
    const diag = await page.evaluate(() => ({
      tails: [...document.querySelectorAll("[data-sidepanel-style]")].map((el) => (el.innerText || "").replace(/\s+/g, " ").slice(0, 160)),
      activeTabs: [...document.querySelectorAll("[data-sidepanel-style] button[aria-label]")].map((b) => b.getAttribute("aria-label")),
    }));
    console.error("  诊断(面板):", JSON.stringify(diag));
  }
  ok(rowShown, "面板里出现 seq #1 的记录行（用户能看到这条记录）");
  ok(!panelText.includes("未返回"), "该记录不是「未返回」（状态已流转 —— #20 的用户症状正是它恒为未返回）");

  ok(consoleTail.length === 0, `页面零报错（实际 ${consoleTail.length} 条）`);

  await killApp(app);
  mockServer.close();
  console.log(`\n✅ PASS: ${passed} 项断言（dsh 真实回合：真内核 + 本地 mock 模型，零 token）`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (e) {
  console.error(`\n❌ FAIL: ${e.message}`);
  console.error("  页面报错:", JSON.stringify(consoleTail.slice(0, 3)));
  await killApp(app).catch(() => {});
  mockServer.close();
  console.error(`   现场保留: ${runRoot}`);
  process.exit(1);
}
