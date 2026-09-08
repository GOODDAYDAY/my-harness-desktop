#!/usr/bin/env node
// pi 模型页 reasoning 复选框真实写盘 e2e —— 隔离 HOME,设置页 → Pi → 模型,
// 翻 reasoning 复选框 → 保存 → models.json 落 reasoning 字段(翻后值)。
// 与 dsh-model-reasoning.e2e.mjs 成对:同一共享 ModelConfigPage,pi 写 models.json(纯透传)、
// dsh 写 settings.yaml reasoningEfforts(映射)。「互相参考两边」的 pi 侧守卫。
// 用法: npm run build && node scripts/demo/pi-model-reasoning.e2e.mjs [--port 9348] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9348" }, keep: { type: "boolean", default: false } } });

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
// 拷贝真实 pi models.json(隔离改副本,不碰真实 profile)
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
const realModels = join(homedir(), ".pi", "agent", "models.json");
if (existsSync(realModels)) copyFileSync(realModels, join(home, ".pi", "agent", "models.json"));
const modelsPath = join(home, ".pi", "agent", "models.json");

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18457" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 开设置 → 点「Pi」分组 → 切「模型」tab
  await page.keyboard.down("Meta"); await page.keyboard.press(","); await page.keyboard.up("Meta");
  await waitForDomIdle(page, { quietMs: 800, timeoutMs: 6000 }).catch(() => {});
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").trim() === "Pi" && e.children.length < 3);
    el[el.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 6000 }).catch(() => {});
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].filter((e) => (e.textContent || "").trim() === "模型" && e.children.length < 3);
    el[el.length - 1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 6000 }).catch(() => {});

  // 找第一个 reasoning 复选框,记录初始态并翻
  const before = JSON.parse(readFileSync(modelsPath, "utf-8"));
  const firstModel = Object.values(before.providers ?? {})[0]?.models?.[0];
  ok(!!firstModel, "models.json 有模型条目");
  const initialReasoning = !!firstModel.reasoning;
  const toggled = await page.evaluate(() => {
    const cbs = [...document.querySelectorAll("input[type='checkbox']")].filter((c) => /reasoning/i.test(c.closest("label")?.textContent ?? ""));
    if (cbs.length === 0) return { found: false };
    const cb = cbs[0];
    const wasChecked = cb.checked;
    cb.click();
    return { found: true, wasChecked };
  });
  ok(toggled.found, "模型页出现 reasoning 复选框(capabilities.reasoning=true)");
  ok(toggled.wasChecked === initialReasoning, `复选框初态与 models.json 一致(初态 ${toggled.wasChecked})`);

  // 保存
  await waitForDomIdle(page, { quietMs: 600, timeoutMs: 5000 }).catch(() => {});
  const saved = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /确定改动/.test(b.textContent || ""));
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  ok(saved, "点「确定改动」保存");
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 8000 }).catch(() => {});

  // 文件对账:models.json 的 reasoning 翻转了
  const after = JSON.parse(readFileSync(modelsPath, "utf-8"));
  const afterModel = Object.values(after.providers ?? {})[0]?.models?.[0];
  ok(!!afterModel.reasoning === !initialReasoning, `models.json reasoning 翻转(${initialReasoning} → ${!!afterModel.reasoning})`);

  ok(consoleTail.length === 0, "页面零报错");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(pi 模型 reasoning 复选框 UI 全链写盘)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
