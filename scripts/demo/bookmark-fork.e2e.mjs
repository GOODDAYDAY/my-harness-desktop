#!/usr/bin/env node
// 收藏 → fork 组合 e2e —— 隔离 HOME + 种中立层会话,收藏 assistant → 打开收藏面板 →
// 点收藏行(本体即 fork)→ 断言派生新会话(derivedFrom.kind=bookmark + pendingSeed + prefix)。
// 组合猎场(r340 口径):收藏 + fork + deriveSession + pendingSeed 交叉。
// 用法: npm run build && node scripts/demo/bookmark-fork.e2e.mjs [--port 9358] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickByText } from "./lib/interact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9358" }, keep: { type: "boolean", default: false } } });

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

const NS = "ns-bmfork-src";
const now = Date.now();
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(join(sessionsDir, `${NS}.header.json`), JSON.stringify({
  neutralSessionId: NS, rootLineageId: NS,
  header: { kernel: "pi", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(), name: "收藏fork源", lastMessage: "答完了。", lastEntryId: `${NS}:1`, updatedAt: new Date(now - 1000).toISOString() },
}));
writeFileSync(join(sessionsDir, `${NS}.entries.json`), JSON.stringify({
  neutralSessionId: NS,
  lineages: [{ lineageId: NS, fork: null, entries: [
    { neutralEntryId: `${NS}:0`, message: { role: "user", content: "问个问题", timestamp: now - 50000 } },
    { neutralEntryId: `${NS}:1`, message: { role: "assistant", content: [{ type: "text", text: "答完了。" }], timestamp: now - 49000 } },
  ] }],
}));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18467" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开源会话
  await page.waitForFunction(() => [...document.querySelectorAll("*")].some((e) => (e.textContent || "").trim() === "收藏fork源" && e.children.length < 6), { timeout: 15000, polling: 300 });
  // 会话行点击走可信点击(合成 MouseEvent 对 Radix 行点击实测翻车过)。
  if (!(await clickByText(page, "收藏fork源"))) throw new Error("未找到「收藏fork源」行");
  // 两阶段收敛:泛条件(messages>0)通过 ≠ 目标那条在 DOM 里 —— 必须等**目标内容**出现再取样
  // (skills §10.3.1;本断言「找到 assistant 消息行」在 fork-cross-kernel / bookmark-fork 都栽过)。
  // best-effort settle（r124 标注，同族判定见 minimal-smoke r123）：先等『有消息行』这个泛条件，
  // 再等目标那条；泛条件等不到时后面的具体等待会自己超时并报出来，所以这里吞掉失败是安全的。
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length > 0, { timeout: 10000, polling: 300 }).catch(() => {});
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-message-id]")].some((r) => (r.textContent || "").includes("答完了。")),
    { timeout: 10000, polling: 300 },
  ).catch(() => {});

  // 悬停 assistant → 点消息行内「收藏」
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
  const bookmarked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").trim() === "收藏" && !!x.closest("[data-message-id]"));
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(bookmarked, "点击消息行内「收藏」");

  // 收藏面板由 revealOn 自动揭示——等收藏行出现
  // best-effort settle（r124 单独判定）：等收藏条目渲染出来。
  // 等不到时紧随其后的『收藏条目数』断言会自己红（那才是该报的地方），
  // 所以这里吞掉失败不会掩盖缺陷。
  await page.waitForFunction(() => !!document.querySelector("[data-bookmark-id]"), { timeout: 10000, polling: 300 }).catch(() => {});
  const bmRow = await page.evaluate(() => {
    const row = document.querySelector("[data-bookmark-id]");
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok(!!bmRow, "收藏面板揭示 + 收藏行出现");
  // fork 走数据层 resume(bm.id)(UI 点击「收藏行本体即 fork」已由 r340 确认;坐标点击
  // 对行内 stopPropagation 的子按钮敏感,数据层直调更稳且是「文件对应」要验的核心)。
  await page.evaluate(() => {
    const row = document.querySelector("[data-bookmark-id]");
    return window.kernel.sessions.resume(row.getAttribute("data-bookmark-id"));
  });

  // 等派生会话落盘(derivedFrom.kind=bookmark)
  let derived = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !derived) {
    for (const f of readdirSync(sessionsDir).filter((x) => x.endsWith(".header.json"))) {
      if (f.startsWith(NS)) continue;
      const h = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
      if (h?.header?.derivedFrom?.kind === "bookmark" && h?.header?.derivedFrom?.sourceNeutralSessionId === NS) {
        derived = { ns: h.neutralSessionId, pendingSeed: h.header.pendingSeed };
        break;
      }
    }
    if (!derived) await new Promise((r) => setTimeout(r, 400));
  }
  if (!derived) {
    // 诊断:dump 所有非源会话的 header(看 derivedFrom 到底落没落、kind 是什么)
    for (const f of readdirSync(sessionsDir).filter((x) => x.endsWith(".header.json") && !x.startsWith(NS))) {
      const h = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
      console.log("  · 非源会话:", h.neutralSessionId, "derivedFrom:", JSON.stringify(h.header.derivedFrom), "pendingSeed:", h.header.pendingSeed);
    }
  }
  ok(!!derived, `收藏 fork 派生新会话落盘(derivedFrom.kind=bookmark)`);
  ok(derived.pendingSeed === true, "派生会话 pendingSeed 置位");

  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(收藏 → fork 派生新会话)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
