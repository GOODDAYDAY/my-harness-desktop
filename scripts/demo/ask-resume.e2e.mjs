#!/usr/bin/env node
// ask 续问真实 DOM e2e(docs/design/ask-design.md §12 核心验收)——拉起 out/ 构建产物
// (隔离 HOME + CDP),真实 pi 内核 + 真实模型(花真 token),验证「进程死=提问不死」:
//   ① 发送指令让模型调 ask_user_question → 提问卡出现
//   ② 直接关掉 app(stopAll 杀内核)——提问悬在半途
//   ③ 重启 app(同一隔离 HOME)→ 重开会话 → 卡片原地复活为交互态(水合重投 + 查询命中)
//   ④ 作答 → 续路:真 toolResult 落盘进 pi 会话 JSONL(逐字段断言)+ 回填消息触发新回合
//      → 模型继续生成(不 400、无「内核未启动/提问已失效」)
//
// 用法: npm run build && node scripts/demo/ask-resume.e2e.mjs [--port 9335] [--keep]
// 注意: 本脚本花真实 token(真实模型调用),与零 token 沙箱场景不同。
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
    port: { type: "string", default: "9335" },
    keep: { type: "boolean", default: false },
  },
});
const PORT = Number(args.port);
const APP_PORT = 18422; // 与 ask-question(18421)/其他兄弟错开

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function waitFor(page, fn, label, timeoutMs = 120000, ...fnArgs) {
  await page.waitForFunction(fn, { timeout: timeoutMs, polling: 300 }, ...fnArgs);
  ok(true, label);
}

/** 等应用服务端端口释放(根因:killApp 后内核/服务端子进程退出需要一点时间,
 *  立刻用同一 MHD_PORT 重启会 bind 失败 → renderer 起得来但连不上服务端,
 *  页面停在「与服务端的连接已断开」。事件驱动等端口拒绝连接,不赌固定 sleep)。 */
async function waitServerPortFree(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
      // 还能连上 = 旧服务端未退尽
    } catch {
      return; // 连接被拒 = 端口已释放
    }
    if (Date.now() > deadline) throw new Error(`服务端端口 ${port} 久等未释放`);
    await new Promise((r) => setTimeout(r, 400));
  }
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

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

await assertPortFree(PORT);
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
const shotsDir = join(runRoot, "e2e-shots");
mkdirSync(shotsDir, { recursive: true });

console.log(`隔离 HOME: ${home}(真实 pi 内核 + 真实模型,花真 token;续问场景)`);
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const scenarioDir = join(HERE, "scenarios", "goal-command");
const bundle = await loadScenario(scenarioDir, "zh-CN");
applySeed(ctx, scenarioDir, bundle.spec, bundle.dict);

let shotN = 0;

/** pi 会话文件(隔离 HOME 下 ~/.pi/agent/sessions/<bucket>/ 里唯一的 .jsonl)。 */
function findPiSessionFile() {
  const root = join(home, ".pi", "agent", "sessions");
  if (!existsSync(root)) return null;
  for (const bucket of readdirSync(root)) {
    const dir = join(root, bucket);
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".jsonl")) return join(dir, f);
    }
  }
  return null;
}

/** 读会话文件里 role=toolResult 的条目。 */
function toolResultsIn(file) {
  return readFileSync(file, "utf-8").split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((j) => j && j.type === "message" && j.message?.role === "toolResult");
}

let app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
let page = app.page;
async function shot(name) {
  shotN += 1;
  await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) }).catch(() => {});
}

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ① 发送指令让模型提问(真实回合)
  await typeIntoComposer(page, "请立即调用 ask_user_question 工具问我一个问题：「选哪个水果？」，选项给「苹果」和「香蕉」两个，得到答案后复述一遍我的选择。别的什么都不要做。");
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector("[data-ask-question]"), "① 提问卡出现");
  await waitFor(
    page,
    () => document.body.innerText.includes("苹果") && document.body.innerText.includes("香蕉"),
    "① 选项「苹果」「香蕉」渲染",
  );
  await shot("01-asked");

  // ② 直接关掉 app(内核被杀,提问悬在半途)
  await killApp(app);
  ok(true, "② 关闭 app(stopAll 杀内核,提问悬在半途)");
  await assertPortFree(PORT);
  await waitServerPortFree(APP_PORT);

  // ③ 重启 app(同一 HOME)→ 重开会话 → 卡片原地复活
  app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
  page = app.page;
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 从会话列表重开会话(列表行文案 = 首条消息截断,按实际可见前缀匹配;
  // 列表渲染异步:等出现再点,点完等内容;落空重试 3 次)
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await page.waitForFunction(
      () => [...document.querySelectorAll("*")].some((e) => (e.textContent || "").includes("请立即调用 ask_user_quest") && e.children.length < 8),
      { timeout: 15000, polling: 300 },
    );
    await page.evaluate(() => {
      const els = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").includes("请立即调用 ask_user_quest") && e.children.length < 8);
      els[els.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    opened = await page.waitForFunction(() => !!document.querySelector("[data-ask-question]"), { timeout: 8000, polling: 300 })
      .then(() => true)
      .catch(() => false);
  }
  ok(opened, "③ 重启后重开会话,提问卡出现在时间线");
  // 复活 = 交互态(选项可点),不是结算摘要
  await waitFor(
    page,
    () => !!document.querySelector('[data-ask-question] [role="radio"], [data-ask-question] [role="checkbox"]'),
    "③ 卡片复活为交互态(选项可点)",
  );
  await shot("03-revived");

  // ④ 作答 → 续路:真 toolResult 落盘 + 回填触发新回合 → 模型继续
  await page.evaluate(() => {
    const card = document.querySelector("[data-ask-question]");
    const opt = card?.querySelector('[role="radio"][aria-label="香蕉"]');
    opt?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 5000 }).catch(() => {});
  await page.evaluate(() => {
    const card = document.querySelector("[data-ask-question]");
    const btns = Array.from(card?.querySelectorAll("button") ?? []);
    const submit = btns.find((b) => (b.innerText || "").trim() === "提交");
    submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  // 真 toolResult 落盘(逐字段断言:role/toolCallId/答案 JSON/isError:false)
  await waitFor(
    page,
    () => {
      // 触发条件:时间线出现结算摘要(卡片结算说明续路已走完落盘+回填)
      return document.body.innerText.includes("answered");
    },
    "④ 卡片结算(续路:落盘 + 回填已发生)",
    180000,
  );
  const sessionFile = findPiSessionFile();
  ok(!!sessionFile, "④ 找到 pi 会话文件");
  const results = toolResultsIn(sessionFile);
  ok(results.length >= 1, "④ 会话文件含真 toolResult(壳续路补写)");
  const tr = results[results.length - 1].message;
  ok(tr.toolName === "ask_user_question" && tr.isError === false, "④ toolResult 形状(toolName + isError:false)");
  ok(typeof tr.content?.[0]?.text === "string" && tr.content[0].text.includes("香蕉"), "④ toolResult 内容含真实答案「香蕉」");

  // 模型继续(回填消息触发的新回合产出新内容;且全程无 400/内核类错误)
  await waitFor(
    page,
    () => document.body.innerText.includes("[ask-answer]"),
    "④ 回填消息上屏([ask-answer] 触发器进时间线)",
    180000,
  );
  // 模型在新回合里产出内容(回填消息之后出现新文本;不规定措辞,只要求「有下文」)
  await waitFor(
    page,
    () => {
      const text = document.body.innerText;
      const idx = text.indexOf("[ask-answer]");
      return idx >= 0 && text.slice(idx + "[ask-answer]".length).trim().length > 20;
    },
    "④ 模型读到答案继续生成(回填之后有新内容)",
    180000,
  );
  ok(!(await page.evaluate(() => document.body.innerText.includes("内核未启动") || document.body.innerText.includes("提问已失效") || document.body.innerText.includes("400"))), "④ 全程无内核类错误/400");
  await shot("04-resumed");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言全部通过(ask 续问:杀内核 → 重启 → 卡片复活 → 续路作答 → 模型继续)`);
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
