#!/usr/bin/env node
// 草稿按会话隔离 e2e —— 隔离 HOME + 种中立层会话(零模型),真 app 里验:
// 会话 A 写草稿 → ⌘N 新会话(空)→ 新会话写草稿 B → 切回 A(恢复草稿 A)→ 再 ⌘N(恢复草稿 B)。
// 零 token(不发送)。补草稿功能(use-session-draft)缺失的真 app 覆盖,并判定 in-mem 草稿失败
// 是产品 bug 还是 jsdom 合成事件时序。
// 用法: npm run build && node scripts/demo/composer-draft.e2e.mjs [--port 9349] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9349" }, keep: { type: "boolean", default: false } } });

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

const NS = "ns-draft-src";
const now = Date.now();
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, `${NS}.header.json`), JSON.stringify({
  neutralSessionId: NS, rootLineageId: NS,
  header: { kernel: "pi", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(), name: "草稿源会话", lastMessage: "答完了。", lastEntryId: `${NS}:1`, updatedAt: new Date(now - 1000).toISOString() },
}));
writeFileSync(join(sessionsDir, `${NS}.entries.json`), JSON.stringify({
  neutralSessionId: NS,
  lineages: [{ lineageId: NS, fork: null, entries: [
    { neutralEntryId: `${NS}:0`, message: { role: "user", content: "问个问题", timestamp: now - 50000 } },
    { neutralEntryId: `${NS}:1`, message: { role: "assistant", content: [{ type: "text", text: "答完了。" }], timestamp: now - 49000 } },
  ] }],
}));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18458" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

const setComposer = async (text) => {
  await page.evaluate((x) => {
    const ta = document.querySelector("[data-timeline-composer]");
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, x);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
};
const readComposer = () => page.evaluate(() => document.querySelector("[data-timeline-composer]")?.value ?? null);
const newChat = async () => {
  await page.keyboard.down("Meta"); await page.keyboard.press("n"); await page.keyboard.up("Meta");
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 6000 }).catch(() => {});
};
const openSession = async () => {
  await page.evaluate(() => {
    const els = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").trim() === "草稿源会话" && e.children.length < 6);
    els[els.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 6000 }).catch(() => {});
};

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开草稿源会话
  await openSession();
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length > 0, { timeout: 10000, polling: 300 }).catch(() => {});

  // 1) 会话 A 写草稿 A
  await setComposer("草稿A");
  await new Promise((r) => setTimeout(r, 400));
  ok((await readComposer()) === "草稿A", "会话 A 写草稿 A");

  // 2) ⌘N 新会话 → 空
  await newChat();
  const newEmpty = await readComposer();
  ok(newEmpty === "", `新会话输入框空(实际「${newEmpty}」)`);

  // 3) 新会话写草稿 B
  await setComposer("草稿B");
  await new Promise((r) => setTimeout(r, 400));
  ok((await readComposer()) === "草稿B", "新会话写草稿 B");

  // 4) 切回会话 A → 恢复草稿 A
  await openSession();
  const restoredA = await readComposer();
  ok(restoredA === "草稿A", `切回恢复草稿 A(实际「${restoredA}」)`);

  // 5) 再 ⌘N → 恢复草稿 B
  await newChat();
  const restoredB = await readComposer();
  ok(restoredB === "草稿B", `再新会话恢复草稿 B(实际「${restoredB}」)`);

  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(草稿按会话隔离,零 token)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
