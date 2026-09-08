#!/usr/bin/env node
// 右侧面板页签全量巡检 e2e —— 隔离 HOME,逐个激活 sidepanel 页签,断言每个组件真实挂载
// (不落「组件未注册」兜底、不产生 console error)。这是 DOM 一致性的廉价全量哨兵:
// 任何页签的 manifest component 名漂移/导出缺失,都会在此现形。
// 用法: npm run build && node scripts/demo/sidepanel-patrol.e2e.mjs [--port 9344] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9344" }, keep: { type: "boolean", default: false } } });

let passed = 0;
const notes = [];
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function note(l) { notes.push(l); console.log(`  · ${l}`); }

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18453" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));
page.on("console", (m) => { if (m.type() === "error") consoleTail.push(m.text()); });

const FALLBACK_TEXTS = ["组件未注册", "元件未註冊", "Komponente nicht registriert", "Component not registered"];

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // 打开右侧面板(⌘J)
  await page.keyboard.down("Meta"); await page.keyboard.press("j"); await page.keyboard.up("Meta");
  // 等 sidepanel slot 数据加载出图标条(页签按钮),事件驱动不赌固定 sleep
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-sidepanel-style] button[aria-label]")].length >= 8,
    { timeout: 15000, polling: 300 },
  ).catch(() => {});

  // 盘点页签按钮(有 aria-label 的 sidepanel tab)
  // 注意:有 2 个 [data-sidepanel-style](图标条 + 展开面板,后者 DOM 序在前且空),
  // querySelector 会命中空面板——用后代选择器跨两者找图标条里的页签按钮。
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll("[data-sidepanel-style] button[aria-label]")].map((b) => b.getAttribute("aria-label")));
  if (tabs.length === 0) {
    // 诊断:strip 是否存在、按钮有没有、右侧面板组是否隐藏、body 文本头
    const diag = await page.evaluate(() => ({
      stripCount: document.querySelectorAll("[data-sidepanel-style]").length,
      anyButtonsWithAria: [...document.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")).slice(0, 25),
      bodyHead: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
    }));
    note(`诊断(页签空): ${JSON.stringify(diag)}`);
  }
  note(`页签数=${tabs.length}: ${tabs.join(", ")}`);
  ok(tabs.length >= 8, `sidepanel 页签 ≥8 个(实际 ${tabs.length})`);

  // 逐个激活,断言组件挂载(无「组件未注册」兜底)+ 无 console error
  let bad = null;
  for (const label of tabs) {
    await page.evaluate((l) => {
      const b = [...document.querySelectorAll("[data-sidepanel-style] button[aria-label]")].find((x) => x.getAttribute("aria-label") === l);
      b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, label);
    await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 }).catch(() => {});
    const hit = await page.evaluate((fs) => {
      const t = document.body.innerText;
      return fs.find((f) => t.includes(f)) ?? null;
    }, FALLBACK_TEXTS);
    if (hit) { bad = `${label}: ${hit}`; break; }
  }
  ok(!bad, `全部 ${tabs.length} 个页签激活零「组件未注册」兜底${bad ? `(坏: ${bad})` : ""}`);
  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条${consoleTail[0] ? `: ${consoleTail[0].slice(0, 120)}` : ""})`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(sidepanel 页签全量巡检)`);
  for (const n of notes) console.log(`  - ${n}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  for (const n of notes) console.error(`  - ${n}`);
  if (consoleTail.length) console.error(`console 错误: ${consoleTail.slice(0, 5).join(" | ")}`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
