#!/usr/bin/env node
// 左栏面板分隔线 e2e —— 真实产物 + 隔离 HOME,验"项目区 / 会话区之间能不能上下拉"。
//
// 覆盖三件事(§5.6 第 3 级:jsdom 测不了的都在这里验——真实排版才有像素高度):
//   A) 两个 group → 两个 Panel + 一条可拖拽分隔线;首屏比例 = defaultSize 提示(25/75),不是均分;
//   B) 真实鼠标拖分隔线 → 高度比随拖动改变,reload 后保持(autoSaveId 持久化);
//   C) 隐藏分割线的侧栏风格(card)下,手柄热区仍在、照样能拖
//      —— 回归守卫:旧实现"热区与线共用一个 token",card/minimal/glass 三种风格里
//      手柄被 display:none 一起干掉,分组拆开了也依然拖不动。
//
// 零 token(不发送任何消息)。用法: npm run build && node scripts/demo/sidebar-panel.e2e.mjs [--port 9361] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9361" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ── 隔离 HOME:项目清单种子 + lastCwd(左栏两个分组都要有内容才占住自己的 Panel) ──
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const projectDirs = ["alpha", "beta", "gamma"].map((n) => join(home, n));
for (const d of projectDirs) mkdirSync(d, { recursive: true });
ctx.writeConfig("projects", { recentCwds: projectDirs });
ctx.setPrefs({ lastCwd: projectDirs[0] });
const shotsDir = join(runRoot, "shots");
mkdirSync(shotsDir, { recursive: true });
let shotN = 0;
const shot = async (page, name) => {
  shotN += 1;
  await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) });
};

/** 左栏几何:两个 Panel 的高度 + 分隔线手柄(热区/内线/光标)的实测样式。 */
const SIDEBAR_GEOM = () => {
  const sidebar = document.querySelector("[data-sidebar-style]");
  if (!sidebar) return null;
  const panels = [...sidebar.querySelectorAll('[data-panel=""]')].map((p) => {
    const r = p.getBoundingClientRect();
    return { h: Math.round(r.height), size: p.getAttribute("data-panel-size") };
  });
  const h = sidebar.querySelector('[role="separator"]');
  const line = h?.firstElementChild ?? null;
  const hr = h?.getBoundingClientRect() ?? null;
  return {
    panels,
    handle: h && hr ? {
      x: Math.round(hr.x + hr.width / 2),
      y: Math.round(hr.y + hr.height / 2),
      height: Math.round(hr.height),
      display: getComputedStyle(h).display,
      cursor: getComputedStyle(h).cursor,
      lineDisplay: line ? getComputedStyle(line).display : null,
    } : null,
  };
};

const geom = (page) => page.evaluate(SIDEBAR_GEOM);
const ratio = (g) => g.panels[0].h / (g.panels[0].h + g.panels[1].h);

let app = null;
try {
  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18461" }, timeoutMs: 90000 });
  let page = app.page;
  const consoleTail = [];
  page.on("pageerror", (e) => consoleTail.push(e.message));

  await page.waitForSelector("[data-sidebar-style]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  await shot(page, "default-first-paint");

  // ── A) 两个 Panel + 一条手柄;首屏比例 = defaultSize(25),不是均分 ──
  let g = await geom(page);
  ok(g?.panels.length === 2, `左栏渲染出 2 个 Panel(实际 ${g?.panels.length})`);
  ok(!!g.handle, "组之间渲染出可拖拽分隔线(role=separator)");
  ok(g.handle.height === 8, `手柄热区高 8px(实际 ${g.handle.height})`);
  ok(g.handle.display === "flex", `手柄热区 display=flex(实际 ${g.handle.display})`);
  ok(g.handle.cursor === "row-resize", `手柄光标 row-resize(实际 ${g.handle.cursor})`);
  ok(g.handle.lineDisplay !== "none", `default 风格下分割线可见(实际 display=${g.handle.lineDisplay})`);
  const r0 = ratio(g);
  ok(Math.abs(r0 - 0.25) < 0.05, `首屏比例 ≈ defaultSize 25%(实际 ${(r0 * 100).toFixed(1)}%,均分会是 50%)`);

  // ── B) 真实鼠标拖分隔线 → 比例改变;reload 后保持 ──
  const beforeH = g.panels[0].h;
  await page.mouse.move(g.handle.x, g.handle.y);
  await page.mouse.down();
  await page.mouse.move(g.handle.x, g.handle.y + 120, { steps: 12 });
  await page.mouse.up();
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 8000 });
  await shot(page, "default-after-drag");
  g = await geom(page);
  const dragDelta = g.panels[0].h - beforeH;
  ok(dragDelta > 80, `向下拖 120px 后项目区变高(实际 +${dragDelta}px)`);
  const rDragged = ratio(g);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-sidebar-style]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  g = await geom(page);
  const rReloaded = ratio(g);
  await shot(page, "default-after-reload");
  ok(Math.abs(rReloaded - rDragged) < 0.03, `reload 后比例保持(拖后 ${(rDragged * 100).toFixed(1)}% → 重载后 ${(rReloaded * 100).toFixed(1)}%)`);

  // ── C) 隐藏分割线的风格(card):热区仍在、照样能拖(旧实现的回归点) ──
  await killApp(app);
  app = null;
  ctx.setPrefs({ sidebarStyle: "card" });
  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18461" }, timeoutMs: 90000 });
  page = app.page;
  page.on("pageerror", (e) => consoleTail.push(e.message));
  await page.waitForSelector("[data-sidebar-style='card']", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  g = await geom(page);
  await shot(page, "card-hidden-divider");
  ok(!!g.handle, "card 风格下分隔线手柄仍在 DOM");
  ok(g.handle.lineDisplay === "none", `card 风格把「线」隐藏了(实际 ${g.handle.lineDisplay})——确认测的是隐藏线的那一档`);
  ok(g.handle.display === "flex" && g.handle.height === 8, `card 风格下手柄热区仍恒在(display=${g.handle.display} / ${g.handle.height}px)——不再跟着线一起消失`);
  const cardBefore = g.panels[0].h;
  await page.mouse.move(g.handle.x, g.handle.y);
  await page.mouse.down();
  await page.mouse.move(g.handle.x, g.handle.y - 100, { steps: 12 });
  await page.mouse.up();
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 8000 });
  g = await geom(page);
  await shot(page, "card-after-drag");
  ok(g.panels[0].h - cardBefore < -60, `card 风格下向上拖 100px 真的改变了高度比(实际 ${g.panels[0].h - cardBefore}px)`);

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条:${consoleTail.slice(0, 2).join(" | ")})`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(左栏面板分隔线,零 token)`);
  console.log(`   截图: ${shotsDir}`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (args.keep) console.error(`   现场保留: ${runRoot}`);
  if (app) await killApp(app).catch(() => {});
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(1);
}
