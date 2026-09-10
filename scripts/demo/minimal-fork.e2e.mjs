#!/usr/bin/env node
// minimal fork 全链 e2e —— 隔离 HOME + 种 minimal 中立层会话(零 token),打开 → 悬停
// assistant 行 → 点「分叉」→ 确认 → 断言派生新中立会话(derivedFrom.kind=fork +
// pendingSeed 置位 + kernel 归属 minimal)→ 选 Minimal Echo 发送 → 物化 minimal 后端。
// 验的是「分叉归壳」对 minimal 成立 + 派生的 kernel 归属不漂(跟随源 header.kernel)。
// 用法: npm run build && node scripts/demo/minimal-fork.e2e.mjs [--port 9351] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9351" }, keep: { type: "boolean", default: false } } });

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

const NS = "ns-fork-min";
const now = Date.now();
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, `${NS}.header.json`), JSON.stringify({
  neutralSessionId: NS, rootLineageId: NS,
  header: { kernel: "minimal", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(), name: "minimal 源会话", lastMessage: "答完了。", lastEntryId: `${NS}:1`, updatedAt: new Date(now - 1000).toISOString() },
}));
writeFileSync(join(sessionsDir, `${NS}.entries.json`), JSON.stringify({
  neutralSessionId: NS,
  lineages: [{ lineageId: NS, fork: null, entries: [
    { neutralEntryId: `${NS}:0`, message: { role: "user", content: "问个问题", timestamp: now - 50000 } },
    { neutralEntryId: `${NS}:1`, message: { role: "assistant", content: [{ type: "text", text: "答完了。" }], timestamp: now - 49000 } },
  ] }],
}));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18455", MHD_ENABLE_KERNELS: "minimal" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开源会话
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    await page.waitForFunction(() => [...document.querySelectorAll("*")].some((e) => (e.textContent || "").trim() === "minimal 源会话" && e.children.length < 6), { timeout: 15000, polling: 300 });
    await page.evaluate(() => {
      const els = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").trim() === "minimal 源会话" && e.children.length < 6);
      els[els.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    opened = await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length > 0, { timeout: 10000, polling: 300 }).then(() => true).catch(() => false);
  }
  ok(opened, "打开 minimal 源会话(消息行渲染)");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});

  // 悬停 assistant 行 → 点「分叉」→ 点「确认分叉?」
  const box = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-message-id]")];
    const row = rows.find((r) => (r.textContent || "").includes("答完了。"));
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok(!!box, "找到 assistant 消息行");
  await page.mouse.move(box.x, box.y);
  await new Promise((r) => setTimeout(r, 700)); // hover 淡入
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").includes("分叉") && !(x.title || "").includes("确认"));
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(clicked, "点击「分叉」(arm)");
  await new Promise((r) => setTimeout(r, 400));
  const confirmed = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").includes("确认分叉"));
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(confirmed, "点击「确认分叉?」执行");

  // 等派生会话落盘:derivedFrom.kind=fork + pendingSeed + kernel=minimal
  let derived = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !derived) {
    for (const f of readdirSync(sessionsDir).filter((x) => x.endsWith(".header.json"))) {
      if (f.startsWith(NS)) continue;
      const h = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
      if (h?.header?.derivedFrom?.kind === "fork" && h?.header?.derivedFrom?.sourceNeutralSessionId === NS) {
        derived = { ns: h.neutralSessionId, pendingSeed: h.header.pendingSeed, kernel: h.header.kernel };
        break;
      }
    }
    if (!derived) await new Promise((r) => setTimeout(r, 500));
  }
  ok(!!derived, "派生新中立会话落盘(derivedFrom.kind=fork)");
  ok(derived.pendingSeed === true, "派生会话 pendingSeed 置位");
  ok(derived.kernel === "minimal", `派生会话 kernel 归属 minimal(实际 ${derived.kernel})`);

  // 选 Minimal Echo → 发送 → 物化 minimal 后端(pendingSeed 清除 + echo)。
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
    const item = [...document.querySelectorAll("[role='menuitem']")].find((el) => (el.textContent || "").includes("Minimal Echo") && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(itemRect.x, itemRect.y);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 6000 }).catch(() => {});

  await page.click("[data-timeline-composer]");
  await page.keyboard.type("分叉后的消息");
  const sendRect = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label^='发送']") || document.querySelector("button[aria-label*='发送']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(sendRect.x, sendRect.y);
  await page.waitForSelector("[aria-label*='停止']", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("[aria-label*='停止']"), { timeout: 30000, polling: 500 }).catch(() => {});
  const echoed = await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((el) => (el.textContent || "").includes("[minimal echo] 分叉后的消息")),
    { timeout: 10000, polling: 300 },
  ).then(() => true).catch(() => false);
  ok(echoed, "派生会话首发物化 + echo(分叉→物化链路通)");

  // 物化后 pendingSeed 清除 + minimal 文件落盘。
  const afterHeader = JSON.parse(readFileSync(join(sessionsDir, `${derived.ns}.header.json`), "utf-8"));
  ok(afterHeader.header.pendingSeed !== true, "物化后 pendingSeed 清除");
  const minimalDir = join(home, ".minimal", "agent", "sessions");
  const minimalFiles = existsSync(minimalDir) ? readdirSync(minimalDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")) : [];
  ok(minimalFiles.length > 0, "派生会话 minimal 文件落盘(.minimal/)");

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条)`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(minimal fork=派生新会话 + kernel 归属 + 物化)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
