#!/usr/bin/env node
// minimal 内核冒烟 e2e —— 隔离 HOME + 种 lastCwd,真 app 里验:
// 1) 应用拉起无崩溃;2) 模型下拉出现「Minimal Echo」(minimal 内核的模型已合流进模型清单)。
// 零 token(不发送)。这是 minimal 成为第三个同级内核的第一道真 app 证据(后续再验发送链路)。
// 用法: npm run build && node scripts/demo/minimal-smoke.e2e.mjs [--port 9350] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
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
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18459", MHD_ENABLE_KERNELS: "minimal" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  ok(true, "应用拉起,composer 就绪");

  // 打开模型下拉:composer 内带 svg 的按钮(排除思考档位),用真实 CDP 鼠标点(§3.2 可信点击)。
  const triggerRect = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg"));
    // 触发器文本 = 当前模型名(长度>2),排除思考档位(off/minimal/low/medium/high/xhigh)。
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
  ok(!!(await page.evaluate(() => !!document.querySelector("[role='menu']"))), "模型下拉已打开");

  // 点「minimal」内核 TAB(真实鼠标)。
  const tabRect = await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    const tab = [...(menu?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().toLowerCase() === "minimal");
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!tabRect) {
    const tabs = await page.evaluate(() => {
      const menu = document.querySelector("[role='menu']");
      return [...(menu?.querySelectorAll("button") ?? [])].map((b) => (b.textContent || "").trim()).filter(Boolean);
    });
    throw new Error(`未找到 minimal TAB(实际 TAB: ${JSON.stringify(tabs)})`);
  }
  await page.mouse.click(tabRect.x, tabRect.y);
  ok(true, "已点击 minimal 内核 TAB");

  // 查「Minimal Echo」(role=menuitem,文本含显示名)。
  const hasMinimal = await page.waitForFunction(
    () => [...document.querySelectorAll("[role='menuitem']")].some((el) => (el.textContent || "").includes("Minimal Echo")),
    { timeout: 8000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(hasMinimal, "模型下拉出现「Minimal Echo」(minimal 内核模型已合流)");

  // 选「Minimal Echo」→ 发消息 → 验证 echo 出现在时间线。
  const itemRect = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role='menuitem']")].find((el) =>
      (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!itemRect) throw new Error("「Minimal Echo」模型项不可点");
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});
  ok(true, "已选「Minimal Echo」");

  // 发消息(真实键盘)。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("你好 minimal");
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label^='发送']") || document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!sendRect) throw new Error("未找到发送按钮");
  await page.mouse.click(sendRect.x, sendRect.y);

  // 两阶段收敛(§3.4):先等「停止」起跑,再等「停止」消失。
  await page.waitForSelector("[aria-label*='停止']", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 30000, polling: 500 }).catch(() => {});
  const echoed = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("[minimal echo] 你好 minimal")),
    // ⚠ 这条是整条链上**唯一不吞超时、且最紧**的预算(第 241/242 轮定位):
    //   前面两阶段收敛(等停止起跑/消失)最多可耗 20s+30s,且**失败会被吞**,
    //   于是"这一轮跑得久"(冷启动+模型加载)会让本行在 10s 内等不到 echo →
    //   报出"端到端发送链路不通" ✗ —— **失败信息指向了错误的组件**。
    //   故把预算放宽到 45s(仍是等待、不是 sleep):它只影响"等多久才判失败",
    //   不影响任何被测行为 ✓。真正的就绪问题仍会由它如实报出 ✓。
    { timeout: 45000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(echoed, "时间线出现 minimal echo 回复(端到端发送链路通)");

  // 文件对应守卫:中立层 header.kernel=minimal,且 minimal 会话文件落 .minimal/(非 .pi/)。
  const neutralDir = join(home, ".my-harness-desktop-dev", "sessions");
  const headers = readdirSync(neutralDir).filter((f) => f.endsWith(".header.json"));
  const latestHeader = headers.sort().map((f) => JSON.parse(readFileSync(join(neutralDir, f), "utf-8"))).pop();
  ok(latestHeader?.header?.kernel === "minimal", "中立层 header.kernel = minimal");
  ok(latestHeader?.header?.custom?.model?.kernel === "minimal", "中立层 model 域 kernel = minimal");
  const minimalDir = join(home, ".minimal", "agent", "sessions");
  const minimalFiles = existsSync(minimalDir) ? readdirSync(minimalDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")) : [];
  ok(minimalFiles.length > 0, "minimal 会话文件落在 .minimal/agent/sessions/");
  const piDir = join(home, ".pi", "agent", "sessions");
  const piJsonl = existsSync(piDir) ? readdirSync(piDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")) : [];
  ok(piJsonl.length === 0, `pi 目录无 minimal 会话文件(实际 ${piJsonl.length} 个)`);

  // 第二轮发送(多轮长交互):验证 append 路径(第二条走 appendFileSync,非首条 header 写)。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("第二条消息");
  await page.mouse.click(sendRect.x, sendRect.y);
  await page.waitForSelector("[aria-label*='停止']", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 30000, polling: 500 }).catch(() => {});
  const echoed2 = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("[minimal echo] 第二条消息")),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(echoed2, "第二轮 echo 出现(多轮 append 路径通)");

  // DOM 组装顺序对账(§3.3 线性序):消息卡片按 user→assistant→user→assistant 顺序渲染。
  const orderOk = await page.evaluate(() => {
    const texts = [...document.querySelectorAll("[data-message-id]")].map((el) => (el.textContent || "").replace(/\s+/g, " "));
    const i1 = texts.findIndex((t) => t.includes("你好 minimal"));
    const i2 = texts.findIndex((t) => t.includes("[minimal echo] 你好 minimal"));
    const i3 = texts.findIndex((t) => t.includes("第二条消息"));
    const i4 = texts.findIndex((t) => t.includes("[minimal echo] 第二条消息"));
    return i1 >= 0 && i1 < i2 && i2 < i3 && i3 < i4;
  });
  ok(orderOk, "消息卡片按 user→assistant→user→assistant 顺序组装(线性序不混)");

  // minimal 会话文件格式对账(§3.3):头行 type=session,消息条目 type=message,共 4 条(2 user + 2 assistant)。
  const minimalFilePath = join(minimalDir, ...minimalFiles[0].split("/"));
  const lines = readFileSync(minimalFilePath, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  ok(lines[0].type === "session", "minimal 文件头行 type=session");
  const msgLines = lines.filter((l) => l.type === "message");
  ok(msgLines.length === 4, `minimal 文件 message 条目 = 4(实际 ${msgLines.length})`);
  ok(msgLines.every((l) => l.message && typeof l.message.role === "string"), "每条 message 条目都含 message.role(格式对应)");
  const userCount = msgLines.filter((l) => l.message.role === "user").length;
  const asstCount = msgLines.filter((l) => l.message.role === "assistant").length;
  ok(userCount === 2 && asstCount === 2, `user=2 / assistant=2(实际 user=${userCount} assistant=${asstCount})`);

  // 重开会话:⌘N 新会话 → 回点 minimal 会话行 → 消息仍在 → 第三条续跑。
  await page.keyboard.down("Meta"); await page.keyboard.press("n"); await page.keyboard.up("Meta");
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 6000 }).catch(() => {});
  const emptyAfterNew = await page.evaluate(() => document.querySelector("[data-timeline-composer]")?.value ?? null);
  ok(emptyAfterNew === "", `⌘N 新会话输入框空(实际「${emptyAfterNew}」)`);

  const rowRect = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-session-path]")];
    const row = rows.find((r) => (r.textContent || "").includes("你好 minimal"));
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (!rowRect) throw new Error("未找到 minimal 会话行(你好 minimal)");
  await page.mouse.click(rowRect.x, rowRect.y);
  // 两阶段收敛(skills §3.3 Virtuoso 只渲染可视窗口 / §3.4 收敛必须两阶段):
  // 先等"有任何消息"落位,再等**目标那条**进 DOM。此前是「泛等一下就一次性取样」
  // ——泛条件先满足时目标那条可能还没进 DOM,产生间歇假红(实测约 2 次 1 次)。
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length > 0, { timeout: 10000, polling: 300 }).catch(() => {});
  const reopened = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("[minimal echo] 第二条消息")),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  if (!reopened) {
    // 失败时留证据:区分「全空」(真 bug)与「有消息但没这条」(渲染窗口/内容问题)。
    const dump = await page.evaluate(() => ({
      n: document.querySelectorAll("[data-message-id]").length,
      texts: [...document.querySelectorAll("[data-message-id]")].map((e) => (e.textContent || "").trim().slice(0, 20)),
    }));
    console.log(`   [诊断] 重开后消息数=${dump.n} 文本=${JSON.stringify(dump.texts)}`);
  }
  ok(reopened, "重开后历史消息仍在(中立层读路径通)");

  // 第三条续跑(重开后重新 seed minimal 后端再发)。
  await page.click("[data-timeline-composer]");
  await page.keyboard.type("第三条续跑");
  await page.mouse.click(sendRect.x, sendRect.y);
  await page.waitForSelector("[aria-label*='停止']", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 30000, polling: 500 }).catch(() => {});
  const echoed3 = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("[minimal echo] 第三条续跑")),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(echoed3, "重开后第三条 echo 出现(续跑链路通)");

  // 收尾文件对账:重开后 minimal 文件仍含第三条(重开未换文件、未丢内容)。
  const finalLines = readFileSync(minimalFilePath, "utf-8");
  ok(finalLines.includes("第三条续跑"), "重开后 minimal 文件含第三条消息(同文件续写)");

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条)`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(minimal 内核冒烟,零 token)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
