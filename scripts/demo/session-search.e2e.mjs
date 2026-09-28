#!/usr/bin/env node
// 会话搜索 e2e —— 隔离 HOME + 种两条中立层会话,点「搜索会话」图标 → 输入 filter →
// 断言列表过滤(命中/不命中)。这是「隐藏输入 → toggle → 过滤」的 DOM 组装检查(r343 口径)。
// 用法: npm run build && node scripts/demo/session-search.e2e.mjs [--port 9357] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9357" }, keep: { type: "boolean", default: false } } });

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

const now = Date.now();
const sessionsDir = join(home, ".my-harness-desktop-dev", "sessions");
mkdirSync(sessionsDir, { recursive: true });
// 两条会话:一条含 "alpha",一条含 "beta"
const seed = (ns, name, text) => {
  writeFileSync(join(sessionsDir, `${ns}.header.json`), JSON.stringify({
    neutralSessionId: ns, rootLineageId: ns,
    header: { kernel: "pi", cwd: projectDir, createdAt: new Date(now - 60000).toISOString(), name, lastMessage: text, lastEntryId: `${ns}:1`, updatedAt: new Date(now - 1000).toISOString() },
  }));
  writeFileSync(join(sessionsDir, `${ns}.entries.json`), JSON.stringify({
    neutralSessionId: ns,
    lineages: [{ lineageId: ns, fork: null, entries: [
      { neutralEntryId: `${ns}:0`, message: { role: "user", content: text, timestamp: now - 50000 } },
      { neutralEntryId: `${ns}:1`, message: { role: "assistant", content: [{ type: "text", text: "答完了。" }], timestamp: now - 49000 } },
    ] }],
  }));
};
seed("ns-search-alpha", "alpha 会话", "alpha needle");
seed("ns-search-beta", "beta 会话", "beta needle");

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18466" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 等两条会话行出现
  await page.waitForFunction(() => [...document.querySelectorAll("[data-session-path]")].some((r) => (r.textContent || "").includes("alpha")), { timeout: 15000, polling: 300 });

  // 点「搜索会话」图标(默认隐藏 input 的入口)
  await page.evaluate(() => {
    // r124：改用稳定锚点。此前按 aria-label 是否含「搜索会话」找按钮——语言绑定探针
    //   （aria-label={t("sessions.search")} 随语言变），换 locale 就找不到、整段搜索测试空转。
    //   ⚠ 注意区分：data-session-search 是**展开/收起搜索的按钮**，
    //     data-session-search-input 才是**输入框**（产品侧 476-477 行的注释早就写明了这个区分）。
    const b = document.querySelector("[data-session-search]");
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // r124：改用稳定锚点（此前 input[placeholder*='搜索会话'] 是语言绑定探针）。
  // 这里等不到就**必须失败**：后面整段都依赖搜索框存在，静默吞掉会让下游断言基于假前提。
  await page.waitForSelector("[data-session-search-input]", { timeout: 8000 });
  // 等展开动画落定(AnimatePresence height/opacity 0.18s):输入框仍处于 height:0/opacity:0
  // 时 page.click 点不到、keyboard 敲不进(实测 inputValue 恒空)。
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 5000 }).catch(() => {});
  const inputShown = await page.evaluate(() => !!document.querySelector("[data-session-search-input]"));
  ok(inputShown, "点搜索图标后输入框出现(隐藏→toggle)");

  // 输入 alpha → 过滤(真实键盘键入:合成 setter+input 事件绕过 React 的 _valueTracker,
  // 不触发受控 input 的 onChange → query 恒空 → 过滤不生效)
  await page.click("[data-session-search-input]");
  await page.keyboard.type("alpha");
  await waitForDomIdle(page, { quietMs: 500, timeoutMs: 5000 }).catch(() => {});
  const filtered = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-session-path]")].map((r) => (r.textContent || "").trim());
    return { hasAlpha: rows.some((t) => t.includes("alpha")), hasBeta: rows.some((t) => t.includes("beta")) };
  });
  ok(filtered.hasAlpha, "过滤后 alpha 命中");
  ok(!filtered.hasBeta, "过滤后 beta 不命中(大小写敏感过滤)");

  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(会话搜索:隐藏输入 toggle + 过滤)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
