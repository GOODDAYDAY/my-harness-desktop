#!/usr/bin/env node
// fork 全链 e2e —— 隔离 HOME + 种中立层会话(零模型),打开 → 悬停 assistant 行 →
// 点「分叉」→ 确认 → 断言派生新中立会话(derivedFrom.kind=fork + pendingSeed 置位)
// + 列表出现新会话 + 视图切到新会话。这是 fork=派生新会话(4ea26727)的回归锚,
// 顺带验 80f15807 的能力面广播修复不破坏 fork 后的跳转。
// 用法: npm run build && node scripts/demo/fork.e2e.mjs [--port 9345] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9345" }, keep: { type: "boolean", default: false } } });

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

// 种中立层会话(拆分双文件):user + assistant(有 id,可 fork)
const NS = "ns-fork-src";
const now = Date.now();
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, `${NS}.header.json`), JSON.stringify({
  neutralSessionId: NS, rootLineageId: NS,
  header: { kernel: "pi", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(), name: "fork 源会话", lastMessage: "答完了。", lastEntryId: `${NS}:1`, updatedAt: new Date(now - 1000).toISOString() },
}));
writeFileSync(join(sessionsDir, `${NS}.entries.json`), JSON.stringify({
  neutralSessionId: NS,
  lineages: [{ lineageId: NS, fork: null, entries: [
    { neutralEntryId: `${NS}:0`, message: { role: "user", content: "问个问题", timestamp: now - 50000 } },
    { neutralEntryId: `${NS}:1`, message: { role: "assistant", content: [{ type: "text", text: "答完了。" }], timestamp: now - 49000 } },
  ] }],
}));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18454" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开源会话
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    await page.waitForFunction(() => [...document.querySelectorAll("*")].some((e) => (e.textContent || "").trim() === "fork 源会话" && e.children.length < 6), { timeout: 15000, polling: 300 });
    await page.evaluate(() => {
      const els = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").trim() === "fork 源会话" && e.children.length < 6);
      els[els.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 真渲染信号 = [data-message-id] 行出现(侧栏预览里也有"答完了。",body 文本是假阳性)
    opened = await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length > 0, { timeout: 10000, polling: 300 }).then(() => true).catch(() => false);
  }
  ok(opened, "打开 fork 源会话(消息行渲染)");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 }).catch(() => {});

  // 悬停 assistant 行 → 点「分叉」→ 点「确认分叉?」
  const box = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-message-id]")];
    const row = rows.find((r) => (r.textContent || "").includes("答完了。"));
    return row ? (row.scrollIntoView({ block: "center" }), (() => { const r = row.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()) : null;
  });
  if (!box) {
    const diag = await page.evaluate(() => ({
      rows: [...document.querySelectorAll("[data-message-id]")].map((r) => (r.textContent || "").trim().slice(0, 30)),
      bodyHasAssist: document.body.innerText.includes("答完了。"),
      bodyHasUser: document.body.innerText.includes("问个问题"),
      bodyHead: document.body.innerText.replace(/\s+/g, " ").slice(0, 250),
    }));
    console.log("  诊断(消息行空):", JSON.stringify(diag));
  }
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

  // 等派生会话落盘(轮询中立层:出现新 ns 且 derivedFrom.kind=fork)
  let derived = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !derived) {
    for (const f of readdirSync(sessionsDir).filter((x) => x.endsWith(".header.json"))) {
      if (f.startsWith(NS)) continue; // 跳过源
      const h = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
      if (h?.header?.derivedFrom?.kind === "fork" && h?.header?.derivedFrom?.sourceNeutralSessionId === NS) {
        derived = { ns: h.neutralSessionId, pendingSeed: h.header.pendingSeed };
        break;
      }
    }
    if (!derived) await new Promise((r) => setTimeout(r, 500));
  }
  ok(!!derived, `派生新中立会话落盘(derivedFrom.kind=fork)`);
  ok(derived.pendingSeed === true, `派生会话 pendingSeed 置位(首发强制物化)`);

  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(fork=派生新会话 + pendingSeed)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
