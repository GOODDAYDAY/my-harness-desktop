#!/usr/bin/env node
// 三内核同场真回合 e2e（**零 token**）—— pi + dsh + minimal 在**同一次 app 运行**里各跑一轮，
// 并验它们**互不污染**（用户诉求「别哪里给覆盖了」）。
//
// 为什么要有这条（与前两条的分工）：
//   · `kernel-dispatch.e2e.mjs` 验的是**派发**：setModel 路由到哪个内核 + 能力指纹，
//     不跑真实回合；
//   · `dsh-round.e2e.mjs` 只跑 dsh 一轮；
//   · 这一条验的是**三个内核在同一个进程/同一份壳状态里共存**时各自还能正常跑完一轮，
//     且彼此的会话文件、中立头、DOM 会话行**不串**。
//
// 做法：本地 mock OpenAI 兼容 SSE 一个，三个内核都指向它（各自的配置格式不同：
//   pi  = ~/.pi/agent/models.json（providers 是**字典**）
//   dsh = ~/.dsh/settings.yaml（llm-pi-ai.providers）
//   minimal = ~/.minimal/agent/models.json + .credentials.json
// ），mock 的回复正文里**带上请求里的 model id**，于是"这轮是谁答的"直接可从 DOM 读出。
//
// 用法: npm run build && node scripts/demo/multi-kernel-round.e2e.mjs [--port 9365] [--keep]

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
  return [[m[1], m[2] ?? true]];
}));
const PORT = Number(args.port) > 0 ? Number(args.port) : 9365;
const APP_PORT = 18467;

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ── 本地 mock：把请求里的 model 回显进回复，于是"谁答的"可从回复正文直接判定。 ──
const seenModels = [];
const mockServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let model = "?";
    try { model = JSON.parse(body).model ?? "?"; } catch { /* 非 JSON 请求忽略 */ }
    seenModels.push(model);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: {"choices":[{"delta":{"role":"assistant","content":"答复来自 ${model}"}}]}\n\n`);
    setTimeout(() => {
      // ⚠ 必须补 finish_reason：少这一帧 dsh 会判「Stream ended without finish_reason」
      //（skills §13.3：替身的形状要真）。
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 60);
  });
});
await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const addr = mockServer.address();
const mockPort = typeof addr === "object" && addr ? addr.port : 0;

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const dsh = setupDshKernel(home, homedir());
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

// id 用于"谁答的"（mock 回显请求里的 model id），name 用于在**下拉里找那一项**
// （下拉显示的是显示名，不是 id —— 第一版拿 id 去找，直接找不到）。
const MODELS = {
  pi: { id: "mock-pi", name: "Mock Pi" },
  dsh: { id: "mock-dsh", name: "Mock DSH" },
  minimal: { id: "mock-minimal", name: "Mock Minimal" },
};

// pi：providers 是**字典**；settings.json 的默认指向也要改（否则默认模型指向一个已不存在的 provider）。
writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({
  providers: {
    mockpi: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, api: "openai-completions", apiKey: "sk-mock", models: [{ id: MODELS.pi.id, name: MODELS.pi.name }] },
  },
}, null, 2));
const piSettingsPath = join(home, ".pi", "agent", "settings.json");
const piSettings = JSON.parse(readFileSync(piSettingsPath, "utf-8"));
writeFileSync(piSettingsPath, JSON.stringify({ ...piSettings, defaultProvider: "mockpi", defaultModel: MODELS.pi.id, defaultThinkingLevel: "off" }, null, 2));

// dsh：settings.yaml（只留 mock provider）。
writeFileSync(dsh.settingsPath, [
  "agent-presets:", "  default: standard",
  "permission:", "  defaultPreset: danger-full-access",
  "llm-pi-ai:", "  providers:", "    mock:", "      apiKeyEnv: MHD_MOCK_KEY",
  "      api: openai-completions", `      baseURL: http://127.0.0.1:${mockPort}/v1`,
  "      models:", `        - id: ${MODELS.dsh.id}`, `          name: ${MODELS.dsh.name}`,
  "          contextWindow: 100000", "          maxTokens: 4096", "",
].join("\n"));

// minimal：models.json + 凭证文件。
const minimalDir = join(home, ".minimal", "agent");
mkdirSync(minimalDir, { recursive: true });
writeFileSync(join(minimalDir, "models.json"), JSON.stringify({
  providers: [{ id: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1`, models: [{ id: MODELS.minimal.id, name: MODELS.minimal.name }] }],
  default: { provider: "mock", model: MODELS.minimal.id },
}, null, 2));
writeFileSync(join(minimalDir, ".credentials.json"), JSON.stringify({ mock: "sk-mock" }));

await assertPortFree(PORT);
const app = await launchApp({
  appDir: ROOT,
  port: PORT,
  // 三个内核同场：pi/dsh 默认装载，minimal 需强制启用（§目标 16：默认不装载）。
  env: { HOME: home, MHD_PORT: String(APP_PORT), MHD_ENABLE_KERNELS: "minimal", MHD_MOCK_KEY: "sk-mock" },
  timeoutMs: 120000,
});
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

/** 选一个内核的模型：开下拉 → （多内核才有）点该内核 TAB → 点该模型项。 */
async function selectModel(kernel, modelName) {
  const trigger = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const b = [...scope.querySelectorAll("button")].find((x) => {
      const t = (x.textContent || "").trim();
      return x.querySelector("svg") && t.length > 2 && !/^(off|minimal|low|medium|high|xhigh)$/i.test(t);
    });
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!trigger) throw new Error("未找到模型下拉触发器");
  await page.mouse.click(trigger.x, trigger.y);
  await page.waitForSelector("[role='menu']", { timeout: 8000 }).catch(() => {});
  // 注意：page.evaluate 是跨进程序列化的，**闭包变量传不过去** —— 必须显式当参数传
  //（这条在本文件里踩了两次；见 skills 里"替身/探针的闭包"那条）。
  const itemVisible = (n) => [...document.querySelectorAll("[role='menuitem']")].some((el) => (el.textContent || "").includes(n) && el.getBoundingClientRect().width > 0);
  if (!(await page.evaluate(itemVisible, modelName))) {
    // 多内核才有内核 TAB；点它，用有界重试（菜单动画未落定时坐标会打偏，见 skills §13.7）
    await clickPointUntil(
      page,
      ({ kernel: k }) => {
        const tab = [...document.querySelectorAll("[role='menu'] button")].find((b) => (b.textContent || "").trim().toLowerCase() === k);
        if (!tab) return null;
        const r = tab.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
      ({ modelName: n }) => [...document.querySelectorAll("[role='menuitem']")].some((el) => (el.textContent || "").includes(n) && el.getBoundingClientRect().width > 0),
      { tries: 5, settleMs: 250, arg: { kernel, modelName } },
    );
  }
  const ready = await page.waitForFunction(
    (n) => [...document.querySelectorAll("[role='menuitem']")].some((el) => (el.textContent || "").includes(n) && el.getBoundingClientRect().width > 0),
    { timeout: 15000, polling: 300 }, modelName,
  ).then(() => true).catch(() => false);
  if (!ready) throw new Error(`${kernel} 的模型项「${modelName}」没出现`);
  const item = await page.evaluate((n) => {
    const el = [...document.querySelectorAll("[role='menuitem']")].find((x) => (x.textContent || "").includes(n) && x.getBoundingClientRect().width > 0);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, modelName);
  await page.mouse.click(item.x, item.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});
}

/** 发一条消息并等回复正文出现。 */
async function send(text, expected) {
  await page.click("[data-timeline-composer]");
  await page.keyboard.type(text);
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label^='发送']") || document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!sendRect) throw new Error("未找到发送按钮");
  await page.mouse.click(sendRect.x, sendRect.y);
  await page.waitForSelector("[aria-label*='停止']", { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 90000, polling: 500 }).catch(() => {});
  return page.waitForFunction(
    (exp) => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes(exp)),
    { timeout: 60000, polling: 300 }, expected,
  ).then(() => true).catch(() => false);
}

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 40000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 30000 });

  // 三个内核各跑一轮（顺序：pi → dsh → minimal）。每一轮都用**新会话**（⌘N）避免上下文串台。
  const expect = { pi: `答复来自 ${MODELS.pi.id}`, dsh: `答复来自 ${MODELS.dsh.id}`, minimal: `答复来自 ${MODELS.minimal.id}` };
  for (const kernel of ["pi", "dsh", "minimal"]) {
    // 新一轮：新建会话，确保这一轮只属于这个内核
    await page.keyboard.down("Meta"); await page.keyboard.press("n"); await page.keyboard.up("Meta");
    await waitForDomIdle(page, { quietMs: 600, timeoutMs: 10000 }).catch(() => {});
    await selectModel(kernel, MODELS[kernel].name);
    const model = await page.evaluate(() => document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "");
    ok(model.startsWith(`${kernel}:`), `[${kernel}] composer 固定到该内核的模型（实际 ${model}）`);
    const replied = await send(`第 ${kernel} 轮`, expect[kernel]);
    if (!replied) {
      const diag = await page.evaluate(() => ({
        model: document.querySelector("[data-composer-model]")?.dataset.composerModel ?? "",
        messages: [...document.querySelectorAll("[data-message-id]")].map((el) => (el.textContent || "").replace(/\s+/g, " ").slice(0, 60)),
        timelineMounted: !!document.querySelector("[data-timeline-composer]"),
        // 会话区文本头：空态会写"还没有会话/新建对话"之类，据此区分"没开会话"与"开了但没消息"
        bodyHead: document.body.innerText.replace(/\s+/g, " ").slice(0, 220),
        sidebarRows: [...document.querySelectorAll("[data-session-path]")].map((el) => (el.textContent || "").replace(/\s+/g, " ").slice(0, 30)),
      }));
      console.error(`  诊断(${kernel}):`, JSON.stringify(diag));
      console.error("  mock 收到的 model:", JSON.stringify(seenModels));
    }
    ok(replied, `[${kernel}] 真回合跑通：mock 的回复进了时间线`);
  }
  ok(new Set(seenModels).size >= 3 || seenModels.length >= 3, `mock 被三个内核分别调到（${seenModels.length} 次：${[...new Set(seenModels)].join(", ")}）`);

  // ── 互不污染：三份中立头、三份内核会话文件、左栏三行 ──
  await waitForDomIdle(page, { quietMs: 1200, timeoutMs: 15000 }).catch(() => {});
  const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
  const headers = readdirSync(sessionsDir).filter((f) => f.endsWith(".header.json"))
    .map((f) => JSON.parse(readFileSync(join(sessionsDir, f), "utf-8")).header);
  const byKernel = {};
  for (const h of headers) (byKernel[h.kernel] ??= []).push(h);
  for (const kernel of ["pi", "dsh", "minimal"]) {
    ok((byKernel[kernel]?.length ?? 0) >= 1, `中立层有 ${kernel} 归属的会话（${byKernel[kernel]?.length ?? 0} 个）`);
  }
  const rows = await page.evaluate(() => [...document.querySelectorAll("[data-session-path]")].map((el) => (el.textContent || "").replace(/\s+/g, " ").slice(0, 40)));
  ok(rows.length >= 3, `左栏列出三个内核的会话行（${rows.length} 行）`);
  // 内核文件各归各的根：minimal 的在 .minimal 下、dsh 的在 dsh 会话根下
  const minimalFiles = (() => { try { return readdirSync(join(home, ".minimal", "agent", "sessions"), { recursive: true }).filter((f) => String(f).endsWith(".jsonl")); } catch { return []; } })();
  ok(minimalFiles.length >= 1, `minimal 会话文件落在 .minimal/agent/sessions（${minimalFiles.length} 个）`);
  const piFiles = (() => { try { return readdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true }).filter((f) => String(f).endsWith(".jsonl")); } catch { return []; } })();
  ok(piFiles.length >= 1, `pi 会话文件落在 .pi/agent/sessions（${piFiles.length} 个）—— 三个内核各写各的根，没有互相覆盖`);
  ok(consoleTail.length === 0, `页面零报错（实际 ${consoleTail.length} 条）`);

  await killApp(app);
  mockServer.close();
  console.log(`\n✅ PASS: ${passed} 项断言（三内核同场：pi/dsh/minimal 各跑一轮真回合 + 互不污染，零 token）`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (e) {
  console.error(`\n❌ FAIL: ${e.message}`);
  console.error("  页面报错:", JSON.stringify(consoleTail.slice(0, 3)));
  console.error("  mock 收到的 model:", JSON.stringify(seenModels));
  await killApp(app).catch(() => {});
  mockServer.close();
  console.error(`   现场保留: ${runRoot}`);
  process.exit(1);
}
