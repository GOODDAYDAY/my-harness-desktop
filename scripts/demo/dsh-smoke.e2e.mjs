#!/usr/bin/env node
// dsh 真实内核 e2e —— 真实 dsh 内核 + 真实模型(llm-pi-ai us-new + 真实 apiKey) + 真实 LLM 调用。
// 不用 minimal echo:发真实消息、等真实回复(非 echo 占位)、验 header.kernel=dsh。
// 用法: npm run build && node scripts/demo/dsh-smoke.e2e.mjs [--port 9350] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline, setupDshKernel } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9350" }, keep: { type: "boolean", default: false }, model: { type: "string" } } });

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

// dsh 真实安装 + 原生配置（三件必须成对，收在 lib/home.mjs 单一来源；抄漏一件 = 内核起不来）。
const dshSetup = setupDshKernel(home, homedir());
if (!dshSetup.available) throw new Error("本机没装 dsh 内核（~/.my-harness-desktop-dev/dsh + ~/.dsh/cordis.yml），本 e2e 需要真实内核");
const realSettings = dshSetup.settingsPath;

// 读 dsh 模型名:优先 Free(compat.supportsDeveloperRole:false 已修 developer role,Free 即可用)。
const dshSettings = readFileSync(realSettings, "utf8");
const specified = args.model;
const freeMatch = dshSettings.match(/name:\s*([^\n]*\(Free\))/);
const dshModelName = (specified ?? freeMatch?.[1])?.trim();
if (!dshModelName) throw new Error("dsh settings.yaml 无模型 name");

// 种 lastCwd。
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

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

  // 点 dsh 内核 TAB(§多内核才渲染 TAB;单内核时 dsh 唯一、模型直接铺开,无 TAB 可点)。
  const tabRect = await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    const tab = [...(menu?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().toLowerCase() === "dsh");
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (tabRect) {
    await page.mouse.click(tabRect.x, tabRect.y);
    ok(true, "已点击 dsh 内核 TAB");
  } else {
    ok(true, "单内核无 TAB,dsh 模型直接铺开");
  }

  // 选真实模型(按显示名匹配)。
  const itemRect = await page.evaluate((name) => {
    const item = [...document.querySelectorAll("[role^='menuitem']")].find((el) =>
      (el.textContent || "").includes(name) && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, dshModelName);
  if (!itemRect) throw new Error(`模型项不可点: ${dshModelName}`);
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  ok(true, `已选 dsh 真实模型 ${dshModelName}`);

  // 发真实消息 → 真实 LLM。
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

  // 文件对应守卫:中立层 header.kernel=dsh。
  const neutralDir = join(home, ".my-harness-desktop-dev", "sessions");
  const headers = readdirSync(neutralDir).filter((f) => f.endsWith(".header.json"));
  const latestHeader = headers.sort().map((f) => JSON.parse(readFileSync(join(neutralDir, f), "utf-8"))).pop();
  ok(latestHeader?.header?.kernel === "dsh", "中立层 header.kernel = dsh");

  // #20 守卫(dsh 请求记录):dsh 会话跑完 → <project>/.my-harness-desktop/llm-logs/<sessionId>.jsonl
  // 出现 request + response 行(行契约与 pi 侧同构),且 index.json 记账 bytes>0。
  // 根因背景:llm-recorder 此前只有 piExtension、无 dshExtension → dsh 侧右侧「请求记录」恒空
  // (不是坏了,是从没接过)。详见 docs/design/llm-recorder-design.md §2.5。
  const logDir = join(projectDir, ".my-harness-desktop", "llm-logs");
  let jsonl = null;
  for (let i = 0; i < 24 && !jsonl; i += 1) {
    if (existsSync(logDir)) jsonl = readdirSync(logDir).find((f) => f.endsWith(".jsonl")) ?? null;
    if (!jsonl) await new Promise((r) => setTimeout(r, 500));
  }
  ok(!!jsonl, `dsh 记录器写出会话日志(实际 ${jsonl ?? "未找到"})`);
  const recRows = readFileSync(join(logDir, jsonl), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  ok(recRows.some((r) => r.kind === "request"), "记录有 request 行(agent/request → LlmCallConfig 原样)");
  ok(recRows.some((r) => r.kind === "response"), "记录有 response 行(边界结算,不伪造 status/message)");
  const recIdx = JSON.parse(readFileSync(join(logDir, "index.json"), "utf-8"));
  // index.json 的键 = **首片文件名(含 .jsonl)**,与 pi 侧同约定、与磁盘同名——这是产品契约,
  // 权威守卫是 dsh-extension-flow.test.ts:247「index 的键必须是首片文件名 = `${SID}.jsonl`」。
  // 此前本断言用 jsonl.replace(/\.jsonl$/, "") 剥掉后缀去查键,永远查不到 → bytes 恒 0 → 假失败
  // (main 上既有,与 session-scope 无关)。续片命名是 <stem>.N.jsonl,归一到首片 <stem>.jsonl。
  const shardKey = jsonl.replace(/\.\d+\.jsonl$/, ".jsonl");
  ok((recIdx.sessions?.[shardKey]?.bytes ?? 0) > 0, `index.json 记账 bytes>0(键=首片文件名含 .jsonl,实际键 ${shardKey})`);

  // 探针锚点正值守卫(item 3):起了内核 → 模型控件在,且锚**带值**。
  // 档位锚不在此正断言:档位控件按**模型**条件渲染(`levels.length > 0` 才画),本 e2e 选的
  // qwen3.8-max 无 reasoning 面 → 控件本就该缺席。正值断言(有档位的模型 → 锚在且带值)
  // 归 kernel-thinking-matrix 幕D(它专挑有档位的模型)。**不断言自己控制不了的量**。
  const anchorVals = await page.evaluate(() => {
    const m = document.querySelector("[data-composer-model]");
    const th = document.querySelector("[data-composer-thinking]");
    return { model: m ? m.getAttribute("data-composer-model") : null, thinking: th ? th.getAttribute("data-composer-thinking") : null };
  });
  ok(!!anchorVals.model && anchorVals.model.includes(":"), `模型锚带值 kernel:id(实际「${anchorVals.model}」)`);
  ok(anchorVals.thinking !== "", `档位锚「在场即带值」不变式(实际 ${JSON.stringify(anchorVals.thinking)};null=该模型无档位,控件缺席正确)`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(dsh 真实内核 + 真实 LLM)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (app) await killApp(app).catch(() => {});
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(1);
}
