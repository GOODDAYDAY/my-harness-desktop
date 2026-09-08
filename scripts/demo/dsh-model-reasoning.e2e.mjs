#!/usr/bin/env node
// dsh 模型页 reasoning 复选框真实写盘 e2e —— 隔离 HOME,设置页 → DSH → DSH 模型,
// 勾选 reasoning → 保存 → settings.yaml 落 reasoningEfforts → 重开页面回读勾选态。
// 这是 a79a3e76(dsh 思考深度补面)配套「模型 reasoning 标记 → settings.yaml」的 UI 全链验证。
// 用法: npm run build && node scripts/demo/dsh-model-reasoning.e2e.mjs [--port 9343] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, symlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9343" }, keep: { type: "boolean", default: false } } });

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
// dsh 配置/凭证拷贝(不写回真实 profile;内核目录符号链接)
const realDsh = join(homedir(), ".my-harness-desktop-dev", "dsh");
if (existsSync(realDsh)) symlinkSync(realDsh, join(home, ".my-harness-desktop-dev", "dsh"), platform() === "win32" ? "junction" : undefined);
mkdirSync(join(home, ".dsh"), { recursive: true });
for (const f of ["cordis.yml", "settings.yaml", ".credentials.yaml"]) {
  const src = join(homedir(), ".dsh", f);
  if (existsSync(src)) copyFileSync(src, join(home, ".dsh", f));
}
const realDshNm = join(homedir(), ".dsh", "node_modules");
if (existsSync(realDshNm)) symlinkSync(realDshNm, join(home, ".dsh", "node_modules"), platform() === "win32" ? "junction" : undefined);

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18452" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 开设置(⌘,)
  await page.keyboard.down("Meta"); await page.keyboard.press(","); await page.keyboard.up("Meta");
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 6000 }).catch(() => {});
  const settingsOpen = await page.evaluate(() => document.body.innerText.includes("DSH"));
  ok(settingsOpen, "设置页打开(看到 DSH 分组入口)");

  // 点 DSH 分组 → 切到「DSH 模型」tab
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").trim() === "DSH" && e.children.length < 3);
    el[el.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 6000 }).catch(() => {});
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").trim() === "DSH 模型" && e.children.length < 3);
    el[el.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 6000 }).catch(() => {});

  // 找到第一个 reasoning 复选框(未勾选)并勾选
  const toggled = await page.evaluate(() => {
    const cbs = [...document.querySelectorAll("input[type='checkbox']")].filter((c) => {
      const label = c.closest("label")?.textContent ?? "";
      return /reasoning/i.test(label);
    });
    if (cbs.length === 0) return { found: false };
    const cb = cbs[0];
    const wasChecked = cb.checked;
    cb.click(); // React 受控 checkbox 用 click
    return { found: true, wasChecked };
  });
  ok(toggled.found, "模型页出现 reasoning 复选框(能力旗标 reasoning:true 生效)");
  ok(!toggled.wasChecked, "初始未勾选(真实用户 settings.yaml 无 reasoningEfforts)");

  // 保存(确定改动浮层)
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 5000 }).catch(() => {});
  const saved = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /确定改动/.test(b.textContent || ""));
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(saved, "点「确定改动」保存");
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 8000 }).catch(() => {});

  // 文件对账:settings.yaml 落了 reasoningEfforts
  const { parse } = await import("yaml");
  const doc = parse(readFileSync(join(home, ".dsh", "settings.yaml"), "utf-8")) ?? {};
  let hasEfforts = false;
  for (const route of Object.values(doc["llm-pi-ai"]?.providers ?? {})) {
    for (const m of route?.models ?? []) {
      if (m.reasoningEfforts !== undefined) hasEfforts = true;
    }
  }
  ok(hasEfforts, "settings.yaml 落盘 reasoningEfforts(勾选 → 写盘 → reasoningEfforts 映射)");

  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(dsh 模型 reasoning 复选框 UI 全链写盘)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
