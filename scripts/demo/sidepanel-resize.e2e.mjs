#!/usr/bin/env node
// 右面板堆叠 Tab 分隔线 e2e —— 真实产物 + 隔离 HOME,验"Tab 之间的高度比能不能拖"。
//
// 回归守卫(与左栏 sidebar-panel.e2e.mjs 同款,但对象是右面板):
//   旧实现把手柄自己的 display 绑在 var(--sidepanel-divider-display) 上,而 card/minimal/
//   glass 三个风格把它设成 none —— "这个风格不要分割线"被物理翻译成"取消这个交互点":
//   右面板堆叠 Tab 的高度比(面板只靠这条手柄调高度)在那三种风格下彻底调不了。
//   A) default 风格:两个 Tab → 两个 Panel + 一条手柄;真实鼠标拖 → 高度比改变;
//   B) card 风格(线被隐藏的那一档):线 display=none,但热区仍在、照样能拖。
//
// 零 token(不发送任何消息)。用法: npm run build && node scripts/demo/sidepanel-resize.e2e.mjs [--port 9363] [--keep]
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
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9363" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
// 两个活跃右面板 Tab(git-review 的 review + session-tree 的 tree)→ 两个 Panel、一条手柄
ctx.setPrefs({ lastCwd: projectDir, activeSidePanelTabs: ["review", "tree"], rightPanelOpen: true });

const shotsDir = join(runRoot, "shots");
mkdirSync(shotsDir, { recursive: true });
let shotN = 0;
const shot = async (page, name) => {
  shotN += 1;
  await page.screenshot({ path: join(shotsDir, `${String(shotN).padStart(2, "0")}-${name}.png`) });
};

/** 右面板几何:含分隔线的那块面板体(data-sidepanel-style 也挂在图标条上,故按"含手柄"筛)。 */
const SIDEPANEL_GEOM = () => {
  const body = [...document.querySelectorAll("[data-sidepanel-style]")].find((e) => e.querySelector('[role="separator"]'))
    ?? [...document.querySelectorAll("[data-sidepanel-style]")].pop();
  if (!body) return null;
  const panels = [...body.querySelectorAll('[data-panel=""]')].map((p) => ({ h: Math.round(p.getBoundingClientRect().height) }));
  const h = body.querySelector('[role="separator"]');
  const hr = h?.getBoundingClientRect() ?? null;
  const line = h?.firstElementChild ?? null;
  return {
    style: body.getAttribute("data-sidepanel-style"),
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

const geom = (page) => page.evaluate(SIDEPANEL_GEOM);

/** 等右面板就绪(两个 Panel 落位)。 */
const waitReady = async (page) => {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-sidepanel-style]")].some((e) => e.querySelectorAll('[data-panel=""]').length >= 2),
    { timeout: 25000, polling: 300 },
  );
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 20000 });
};

let app = null;
try {
  // ── A) default 风格:手柄在、拖得动 ──
  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18463" }, timeoutMs: 90000 });
  let page = app.page;
  const consoleTail = [];
  page.on("pageerror", (e) => consoleTail.push(e.message));
  await waitReady(page);
  await shot(page, "default-first-paint");

  let g = await geom(page);
  ok(g.style === "default", `右面板风格 = default(实际 ${g.style})`);
  ok(g.panels.length === 2, `两个活跃 Tab → 两个 Panel(实际 ${g.panels.length})`);
  ok(!!g.handle, "两个 Panel 之间渲染出可拖拽分隔线(role=separator)");
  ok(g.handle.height === 8 && g.handle.display === "flex", `手柄热区恒定(8px / display=${g.handle.display})`);
  ok(g.handle.cursor === "row-resize", `手柄光标 row-resize(实际 ${g.handle.cursor})`);
  ok(g.handle.lineDisplay !== "none", `default 风格下分割线可见(实际 ${g.handle.lineDisplay})`);

  const before = g.panels[0].h;
  await page.mouse.move(g.handle.x, g.handle.y);
  await page.mouse.down();
  await page.mouse.move(g.handle.x, g.handle.y + 100, { steps: 12 });
  await page.mouse.up();
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 8000 });
  await shot(page, "default-after-drag");
  g = await geom(page);
  ok(g.panels[0].h - before > 60, `default 风格下向下拖 100px 改变了 Tab 高度比(实际 ${g.panels[0].h - before}px)`);

  // ── B) card 风格:线隐藏,但热区仍在、照样能拖(旧实现的回归点) ──
  await killApp(app);
  app = null;
  ctx.setPrefs({ sidepanelStyle: "card" });
  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18463" }, timeoutMs: 90000 });
  page = app.page;
  page.on("pageerror", (e) => consoleTail.push(e.message));
  await waitReady(page);
  await shot(page, "card-hidden-divider");

  g = await geom(page);
  ok(g.style === "card", `右面板风格 = card(实际 ${g.style})`);
  ok(!!g.handle, "card 风格下分隔线手柄仍在 DOM");
  ok(g.handle.lineDisplay === "none", `card 风格把「线」隐藏了(实际 ${g.handle.lineDisplay})——确认测的是隐藏线的那一档`);
  ok(g.handle.display === "flex" && g.handle.height === 8, `card 风格下手柄热区仍恒在(display=${g.handle.display} / ${g.handle.height}px)——不再跟着线一起消失`);

  const cardBefore = g.panels[0].h;
  await page.mouse.move(g.handle.x, g.handle.y);
  await page.mouse.down();
  await page.mouse.move(g.handle.x, g.handle.y - 90, { steps: 12 });
  await page.mouse.up();
  await waitForDomIdle(page, { quietMs: 400, timeoutMs: 8000 });
  g = await geom(page);
  await shot(page, "card-after-drag");
  ok(g.panels[0].h - cardBefore < -50, `card 风格下向上拖 90px 真的改变了 Tab 高度比(实际 ${g.panels[0].h - cardBefore}px)`);

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条:${consoleTail.slice(0, 2).join(" | ")})`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(右面板 Tab 分隔线,零 token)`);
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
