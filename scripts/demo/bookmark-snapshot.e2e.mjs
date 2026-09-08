#!/usr/bin/env node
// 收藏快照落盘 e2e —— 隔离 HOME + 种中立层会话(零模型),打开 → 悬停 assistant 行 →
// 点「收藏」→ 断言 `<cwd>/.my-harness-desktop/bookmarks/<id>.json` 落盘(自包含中立快照)。
// 这是「收藏动作 → 快照落盘」的文件对应对账(r340 口径)。
// 用法: npm run build && node scripts/demo/bookmark-snapshot.e2e.mjs [--port 9355] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9355" }, keep: { type: "boolean", default: false } } });

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

const NS = "ns-bm-src";
const now = Date.now();
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, `${NS}.header.json`), JSON.stringify({
  neutralSessionId: NS, rootLineageId: NS,
  header: { kernel: "pi", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(), name: "收藏源会话", lastMessage: "答完了。", lastEntryId: `${NS}:1`, updatedAt: new Date(now - 1000).toISOString() },
}));
writeFileSync(join(sessionsDir, `${NS}.entries.json`), JSON.stringify({
  neutralSessionId: NS,
  lineages: [{ lineageId: NS, fork: null, entries: [
    { neutralEntryId: `${NS}:0`, message: { role: "user", content: "问个问题", timestamp: now - 50000 } },
    { neutralEntryId: `${NS}:1`, message: { role: "assistant", content: [{ type: "text", text: "答完了。" }], timestamp: now - 49000 } },
  ] }],
}));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18464" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开源会话
  await page.waitForFunction(() => [...document.querySelectorAll("*")].some((e) => (e.textContent || "").trim() === "收藏源会话" && e.children.length < 6), { timeout: 15000, polling: 300 });
  await page.evaluate(() => {
    const els = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").trim() === "收藏源会话" && e.children.length < 6);
    els[els.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length > 0, { timeout: 10000, polling: 300 }).catch(() => {});

  // 悬停 assistant 行 → 点「收藏」
  const box = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-message-id]")].find((r) => (r.textContent || "").includes("答完了。"));
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok(!!box, "找到 assistant 消息行");
  await page.mouse.move(box.x, box.y);
  await new Promise((r) => setTimeout(r, 700));
  // 必须点「消息行内」的收藏钮(title=收藏 且在 [data-message-id] 内)——titlebar 也有
  // 同 title 的「收藏」钮(右栏 toggle,r319),点它只开面板不落快照。
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").trim() === "收藏" && !!x.closest("[data-message-id]"));
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(clicked, "点击消息行内「收藏」");

  // 等快照落盘(轮询 bookmarks 目录)
  const bookmarksDir = join(projectDir, ".my-harness-desktop", "bookmarks");
  let snapshotFiles = [];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && snapshotFiles.length === 0) {
    snapshotFiles = existsSync(bookmarksDir) ? readdirSync(bookmarksDir).filter((f) => f.endsWith(".json")) : [];
    if (snapshotFiles.length === 0) await new Promise((r) => setTimeout(r, 400));
  }
  ok(snapshotFiles.length > 0, `收藏快照落盘(bookmarks 目录 ${snapshotFiles.length} 个文件)`);
  if (snapshotFiles.length > 0) {
    const snap = JSON.parse(readFileSync(join(bookmarksDir, snapshotFiles[0]), "utf-8"));
    ok(snap.sourceNeutralSessionId === NS, `快照自包含(溯源 sourceNeutralSessionId=${snap.sourceNeutralSessionId})`);
    ok(Array.isArray(snap.lineage?.entries), "快照含中立 entry 前缀");
  }

  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(收藏动作 → 快照落盘文件对应)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
