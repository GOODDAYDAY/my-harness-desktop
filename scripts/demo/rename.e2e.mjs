#!/usr/bin/env node
// 会话重命名 e2e —— 隔离 HOME + 种中立层会话(零模型),右键会话行 → 重命名 → 键入 Enter,
// 断言中立层 header.name 更新(文件对应)。命名是第七意图(setSessionName),此前无专用 e2e 守卫。
// 用法: npm run build && node scripts/demo/rename.e2e.mjs [--port 9346] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9346" }, keep: { type: "boolean", default: false } } });

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

const NS = "ns-rename-src";
const now = Date.now();
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, `${NS}.header.json`), JSON.stringify({
  neutralSessionId: NS, rootLineageId: NS,
  header: { kernel: "pi", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(), name: "rename 源", lastMessage: "答完了。", lastEntryId: `${NS}:1`, updatedAt: new Date(now - 1000).toISOString() },
}));
writeFileSync(join(sessionsDir, `${NS}.entries.json`), JSON.stringify({
  neutralSessionId: NS,
  lineages: [{ lineageId: NS, fork: null, entries: [
    { neutralEntryId: `${NS}:0`, message: { role: "user", content: "问个问题", timestamp: now - 50000 } },
    { neutralEntryId: `${NS}:1`, message: { role: "assistant", content: [{ type: "text", text: "答完了。" }], timestamp: now - 49000 } },
  ] }],
}));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18455" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 等会话行出现(「rename 源」)
  await page.waitForFunction(() => [...document.querySelectorAll("[data-session-path]")].some((r) => (r.textContent || "").includes("rename 源")), { timeout: 15000, polling: 300 });

  // 右键会话行 → 点「重命名」
  const rowBox = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-session-path]")].find((r) => (r.textContent || "").includes("rename 源"));
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok(!!rowBox, "找到会话行");
  await page.mouse.click(rowBox.x, rowBox.y, { button: "right" });
  await page.waitForSelector("[role='menu']", { timeout: 8000 }).catch(() => {});
  // Radix ContextMenu.Item 的 onSelect 用可信点击触发(合成 click 不保证触发)——取菜单项坐标 mouse.click
  const itemBox = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[role^='menuitem']")].find((m) => (m.textContent || "").includes("重命名"));
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok(!!itemBox, "右键菜单点「重命名」");
  await page.mouse.click(itemBox.x, itemBox.y);

  // 编辑行没有 data-session-path(编辑态行是另一个 div),按 value 找 rename input
  await page.waitForFunction(() => [...document.querySelectorAll("input")].some((i) => i.value === "rename 源"), { timeout: 8000, polling: 200 }).catch(() => {});
  const typed = await page.evaluate(() => {
    const inp = [...document.querySelectorAll("input")].find((i) => i.value === "rename 源");
    if (!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(inp, "新名字-已改");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return true;
  });
  ok(typed, "键入新名 + Enter 提交");
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 8000 }).catch(() => {});

  // 文件对账:中立层 header.name 已更新
  const header = JSON.parse(readFileSync(join(sessionsDir, `${NS}.header.json`), "utf-8"));
  ok(header.header.name === "新名字-已改", `中立层 header.name 更新(实际「${header.header.name}」)`);

  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(会话重命名 = 命名意图文件对应)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
