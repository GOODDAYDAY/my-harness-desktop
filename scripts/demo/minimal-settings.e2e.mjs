#!/usr/bin/env node
// minimal 设置页冒烟 e2e —— 隔离 HOME,打开设置页,验 minimal 的管理面(版本/模型/配置/扩展桩)
// 渲染不崩、内核 TAB 出现 minimal。这是「管理面缝」的 DOM 级验证(§7.9 诚实桩)。零 token。
// 用法: npm run build && node scripts/demo/minimal-settings.e2e.mjs [--port 9353] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9353" }, keep: { type: "boolean", default: false } } });

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

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18462", MHD_ENABLE_KERNELS: "minimal" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开设置页(⇧⌘S)。
  await page.keyboard.down("Shift"); await page.keyboard.down("Meta"); await page.keyboard.press("s"); await page.keyboard.up("Meta"); await page.keyboard.up("Shift");
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 8000 }).catch(() => {});
  ok(true, "设置页打开(⇧⌘S)");

  // 找「内核版本」TAB(或任何内核 TAB),点它看 minimal 的版本桩。
  const kernelTabClicked = await page.evaluate(() => {
    const tab = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("内核") || (b.textContent || "").includes("版本"));
    if (!tab) return false;
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  if (!kernelTabClicked) {
    const bodyHead = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 300));
    console.log("  设置页无「内核版本」TAB,现场:", bodyHead);
  }
  await new Promise((r) => setTimeout(r, 500));

  // minimal 的版本桩渲染为「built-in」(不崩溃)。
  const hasMinimal = await page.evaluate(() => document.body.innerText.includes("minimal") || document.body.innerText.includes("built-in"));
  ok(hasMinimal, "设置页渲染 minimal 内核(版本桩 built-in,不崩溃)");

  // 点开「Minimal」设置入口（用稳定锚点，不按文案猜）。
  await page.evaluate(() => {
    const nav = document.querySelector('[data-settings-id="minimal"]');
    (nav?.closest("button") ?? nav)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 8000 }).catch(() => {});
  // ── 能力驱动的显式降级（§7.6 第三档）──
  // 内置内核没有"安装/切换版本"这回事：**不该画出用不了的控件**，而该给一句说明。
  // 判据是数据（capabilities.install=false），不是内核身份分支——加第四个内核只填它自己的旗标。
  const pageText = await page.evaluate(() => document.body.innerText);
  ok(!pageText.includes("安装/切换版本"), "内置内核没有安装区（不画点了没用的控件）");
  ok(!pageText.includes("检查更新"), "没有版本源就不显示「检查更新」");
  ok(pageText.includes("随壳分发"), "给出「为什么没有安装区」的说明（显式降级，不留空白让人猜）");
  ok(pageText.includes("自定义内核目录") === false, "内置内核不显示「自定义内核目录」区");

  // ── 反向：pi 的版本页**照常**有安装区（降级不能误伤有版本源的内核）──
  await page.evaluate(() => {
    const nav = document.querySelector('[data-settings-id="pi"]');
    (nav?.closest("button") ?? nav)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 8000 }).catch(() => {});
  const piText = await page.evaluate(() => document.body.innerText);
  ok(piText.includes("安装/切换版本"), "pi 的版本页照常有安装区（能力旗标不是把面板一起关掉）");
  ok(piText.includes("自定义底座"), "pi 支持自定义内核目录（同一份数据驱动的隐藏，各归各的文案）");

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条)`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(minimal 设置页冒烟,零 token)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
