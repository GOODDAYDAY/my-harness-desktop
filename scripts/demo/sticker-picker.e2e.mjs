#!/usr/bin/env node
// 表情包快速入口(网格选择器)真实 DOM e2e —— 拉起 out/ 构建产物(隔离 HOME + CDP),
// 真实点击 composer 左下表情包按钮,逐步断言 DOM;全部通过 → exit 0,失败 → exit 1 留诊断截图。
//
// 用法:
//   npm run build && node scripts/demo/sticker-picker.e2e.mjs [--port 9225] [--keep]
//
// 覆盖(jsdom e2e 管不到的真实布局面):
//   ① 点按钮 → 弹层打开;getComputedStyle 读到真实网格轨道(非 repeat 未解析值)——
//     生产列数来源是 resolved tracks,宽度公式只是 jsdom 兜底
//   ② ↓ = 垂直下移一行(几何:同列、y 增一整行;索引:+列数);↑ 越顶回该列末行(列保持);
//     ← 越界平铺回绕到末项——每步选中项标题条([data-sticker-selection])与选中格同步
//     (弹层含内置层,总数不定:断言用几何/相对索引,不写死条数)
//   ③ 键位提示在顶栏中缝:迷你字号(10px 计算值);提示全文唯一(底部独立条已移除)
//   ④ 「加入」按钮 → stickers:fillComposer 真通道:文本追加进真实输入框,弹层关,不发送
//   ⑤ Esc 关闭弹层
//
// 确定性:不发送任何消息(无 Enter),零 token;种子 7 张项目贴纸无 banner(文本格,无图加载竞态)。
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { loadScenario, applySeed } from "./lib/seed/engine.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "9225" },
    keep: { type: "boolean", default: false },
  },
});
const PORT = Number(args.port);
const APP_PORT = 18421;

const WORDS = ["一", "二", "三", "四", "五", "六", "七"];
const STICKERS = WORDS.map((w, i) => ({
  id: `e2e-s${i + 1}`, title: `标题${w}`, content: `内容${w}`,
  order: i, createdAt: 1, updatedAt: 1,
}));

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function waitFor(page, fn, label, timeoutMs = 8000, ...fnArgs) {
  await page.waitForFunction(fn, { timeout: timeoutMs, polling: 100 }, ...fnArgs);
  ok(true, label);
}

async function clickSel(page, sel) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  if (!box) throw new Error(`点击目标不存在: ${sel}`);
  await page.mouse.click(box.x, box.y);
  await waitForDomIdle(page, { quietMs: 300, timeoutMs: 5000 }).catch(() => {});
}

// ── 主流程 ──
if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}

await assertPortFree(PORT);
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
const shotsDir = join(runRoot, "e2e-shots");
mkdirSync(shotsDir, { recursive: true });

console.log(`隔离 HOME: ${home}`);
console.log(`截图: ${shotsDir}(--keep 保留整根)`);
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
// 复用 stickers 场景的项目/会话种子(其会话 rows 带 $t 键,字典必须经 loadScenario 载入),
// 本场景只在其上叠加项目级 stickers 配置(7 张无 banner 贴纸,走 projectConfigs 通道)。
const scenarioDir = join(HERE, "scenarios", "stickers");
const bundle = await loadScenario(scenarioDir, "zh-CN");
applySeed(ctx, scenarioDir, {
  ...bundle.spec,
  projectConfigs: { todo: { stickers: { stickers: STICKERS } } },
}, bundle.dict);
// 空模型清单覆写(与 goal-command 同款确定性):本场景不发送,仅兜底任何意外触发。
writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: {} }));

const app = await launchApp({ appDir: ROOT, port: PORT, env: { HOME: home, MHD_PORT: String(APP_PORT) }, timeoutMs: 90000 });
const page = app.page;
let shotN = 0;
async function shot(name) {
  shotN += 1;
  await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) });
}

/** 选中格快照:索引 + 几何(供垂直/同列断言)+ 标题(供标题条同步断言)。 */
function selectedCell(page) {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll("[data-sticker-cell]")];
    const i = cells.findIndex((c) => (c.style.outline ?? "").includes("solid"));
    if (i < 0) return null;
    const r = cells[i].getBoundingClientRect();
    return { i, x: r.left, y: r.top, total: cells.length, title: cells[i].getAttribute("title") ?? "" };
  });
}
/** 选中项标题条文本(弹层打开时才有节点)。 */
function selectionText(page) {
  return page.evaluate(() => document.querySelector("[data-sticker-selection]")?.textContent ?? null);
}
/** 真实网格列数:读 resolved grid tracks(生产列数来源;repeat 未解析 = 读轨失败)。 */
function gridCols(page) {
  return page.evaluate(() => {
    const grid = document.querySelector("[data-sticker-grid]");
    if (!grid) return 0;
    const tracks = getComputedStyle(grid).gridTemplateColumns;
    if (!tracks || tracks.includes("repeat")) return -1;
    return tracks.split(" ").filter(Boolean).length;
  });
}
/** 等选中格离开 from 索引并返回新快照。 */
async function waitSelectionMove(page, from, label) {
  await page.waitForFunction((f) => {
    const cells = [...document.querySelectorAll("[data-sticker-cell]")];
    return cells.findIndex((c) => (c.style.outline ?? "").includes("solid")) !== f;
  }, { timeout: 8000, polling: 100 }, from);
  const cur = await selectedCell(page);
  ok(cur !== null, label);
  return cur;
}
/** 标题条与选中格同步:条文本含选中格标题(有标题时条=「标题 · 首行」,无标题时=首行=格标题)。 */
async function assertStripSync(page, cell, label) {
  const strip = await selectionText(page);
  ok(strip !== null && strip.includes(cell.title), `${label}(条=「${strip}」)`);
}

try {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });

  // ① 打开弹层:格子装载 + 真实列数 + 初始标题条
  await clickSel(page, '[title="表情包快速入口"]');
  await waitFor(page, () => document.querySelectorAll("[data-sticker-cell]").length >= 7
    && (c => (c.style.outline ?? "").includes("solid"))(document.querySelectorAll("[data-sticker-cell]")[0]),
    "① 弹层打开,≥7 格(项目 7 + 内置层),初始选中首格");
  const cols = await gridCols(page);
  ok(cols >= 2, `① 真实网格轨道解析成功(${cols} 列,非 repeat 兜底值)`);
  const s0 = await selectedCell(page);
  await assertStripSync(page, s0, "① 标题条与首格同步");
  await shot("picker-open");

  // ② ↓ 垂直下移一行:索引 +列数,几何同列、y 增一整行
  await page.keyboard.press("ArrowDown");
  const s1 = await waitSelectionMove(page, 0, "② ↓ 后选中格移动");
  ok(s1.i === cols, `② ↓ = +列数(0 → ${s1.i},列数 ${cols})`);
  ok(Math.abs(s1.x - s0.x) <= 1 && s1.y > s0.y + 40, "② ↓ 几何垂直:同列、下移一整行(不是右移)");
  await assertStripSync(page, s1, "② 标题条跟随 ↓");

  // ② ↑ 越顶:回该列末行(列保持回绕)
  await page.keyboard.press("ArrowUp"); // 先回首行
  await waitSelectionMove(page, s1.i, "② ↑ 回首行");
  const sTop = await selectedCell(page);
  await page.keyboard.press("ArrowUp"); // 越顶
  const s2 = await waitSelectionMove(page, sTop.i, "② ↑ 越顶后选中格移动");
  const wantWrap = (Math.ceil(s2.total / cols) - 1) * cols; // 列 0 的末行格(每行必有列 0)
  ok(s2.i === wantWrap, `② ↑ 越顶回该列末行(索引 ${s2.i} = ${wantWrap})`);
  ok(Math.abs(s2.x - sTop.x) <= 1 && s2.y > sTop.y, "② ↑ 越顶几何:同列到底(不是左移)");
  await assertStripSync(page, s2, "② 标题条跟随越顶 ↑");

  // ② ← 越界平铺回绕到末项
  await page.keyboard.press("ArrowDown"); // 越顶态 ↓ 回首行(列保持)
  const s3 = await waitSelectionMove(page, s2.i, "② ↓ 回首行");
  await page.keyboard.press("ArrowLeft");
  const s4 = await waitSelectionMove(page, s3.i, "② ← 后选中格移动");
  ok(s4.i === s4.total - 1, `② ← 越界平铺回绕到末项(索引 ${s4.i} = ${s4.total - 1})`);
  await assertStripSync(page, s4, "② 标题条跟随 ←");
  await shot("picker-nav");

  // ③ 键位提示:顶栏中缝 + 迷你字号 + 全文唯一(底部条已移除)
  const hintInfo = await page.evaluate(() => {
    const picker = document.querySelector("[data-sticker-picker]");
    const hint = document.querySelector("[data-sticker-keys-hint]");
    if (!picker || !hint) return null;
    const header = hint.parentElement;
    const hits = [];
    const walker = document.createTreeWalker(picker, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent.includes("Enter 直接发")) hits.push(n.textContent.trim());
    }
    return {
      fontSize: getComputedStyle(hint).fontSize,
      isHeaderMiddle: header === picker.firstElementChild
        && header.firstElementChild !== hint && header.lastElementChild !== hint,
      unique: hits.length === 1,
    };
  });
  ok(hintInfo !== null, "③ 键位提示节点存在");
  ok(hintInfo.fontSize === "10px", `③ 迷你字号(计算值 ${hintInfo.fontSize})`);
  ok(hintInfo.isHeaderMiddle, "③ 位于顶栏中缝(标题与操作提示之间)");
  ok(hintInfo.unique, "③ 提示全文唯一(底部独立提示条已移除)");

  // ④ 「加入」→ fillComposer 真通道:按标题找种子格(内置层混入,不写死索引)
  await page.evaluate(() => {
    const cells = [...document.querySelectorAll("[data-sticker-cell]")];
    const cell = cells.find((c) => c.getAttribute("title") === "标题二");
    cell?.querySelector("button")?.click();
  });
  await waitFor(page, () => !document.querySelector("[data-sticker-picker]"), "④ 点「加入」后弹层关闭");
  await waitFor(
    page,
    () => (document.querySelector("[data-timeline-composer]")?.value ?? "") === "内容二",
    "④ 贴纸文本原样入输入框(追加语义,不发送)",
  );
  await shot("fill-composer");

  // ⑤ Esc 关闭
  await clickSel(page, '[title="表情包快速入口"]');
  await waitFor(page, () => !!document.querySelector("[data-sticker-picker]"), "⑤ 重开弹层");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector("[data-sticker-picker]"), "⑤ Esc 关闭弹层");

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项 DOM 断言全部通过(表情包选择器:垂直导航/标题条/顶栏提示/加入输入框)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  try {
    await shot("failure");
    const diag = await page.evaluate(() => ({
      picker: !!document.querySelector("[data-sticker-picker]"),
      cells: document.querySelectorAll("[data-sticker-cell]").length,
      selection: document.querySelector("[data-sticker-selection]")?.textContent ?? null,
      composer: document.querySelector("[data-timeline-composer]")?.value ?? null,
      bodySnippet: document.body.innerText.slice(0, 300),
    })).catch(() => null);
    if (diag) console.error("现场:", JSON.stringify(diag, null, 2));
  } catch { /* 诊断失败不掩盖原因 */ }
  await killApp(app).catch(() => {});
  console.error(`诊断截图保留: ${shotsDir}`);
  process.exit(1);
}
