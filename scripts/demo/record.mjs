#!/usr/bin/env node
// demo 录制入口 —— 一套剧本,每个 locale 跑一遍,各出一条 GIF(README 双语物料)。
//
// 用法:
//   npm run build && node scripts/demo/record.mjs [--scenario workbench]
//   node scripts/demo/record.mjs --locales zh-CN,en --scenario pins [--port 9222] [--keep-frames]
//
// 场景 = 独立个体(scenarios/<name>/ 数据 bundle):
//   index.mjs  steps(纯行为,文案走 $t key)
//   seed.json  声明式种子(prefs/configs/projects/sessions/skills/llmLogs)
//   locales/   场景文案字典(zh/en,覆盖 common presets 字典)
// common(lib/)只提供机制:隔离 HOME 基线、种子解释引擎、录制管线。
//
// 流水线(每 locale):在 /tmp/pi-demo-<ts>/<locale>/ 现搭一次性 HOME(基线:空数据根 +
// 符号链接借真实 HOME 的 pi 底座与 models.json + 底座/偏好默认)→ engine 按 seed.json
// 写演示状态($t 按 locale 解析)→ HOME 覆盖拉起 electron(CDP)→ 校验 locale
// (不一致走语言页兜底)→ 逐步执行剧本(涟漪 + 截帧)→ kill → ffmpeg 合成 GIF。
// 环境一次性、每次执行全新路径:重复执行互不污染,GIF 不携带真实 profile 的
// 会话/路径/扩展等个人信息。
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { loadScenario, applySeed } from "./lib/seed/engine.mjs";
import { createResolver } from "./lib/i18n.mjs";
import { locate } from "./lib/locate.mjs";
import { Recorder } from "./lib/recorder.mjs";
import { ripple } from "./lib/ripple.mjs";
import { typeText, selectAcross, rightClick, waitAgent } from "./lib/interact.mjs";
import { sleep, waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const { values: args } = parseArgs({
  options: {
    locales: { type: "string", default: "zh-CN,en" },
    scenario: { type: "string", default: "workbench" },
    port: { type: "string", default: "9222" },
    "keep-frames": { type: "boolean", default: false },
  },
});

const locales = args.locales.split(",").map((s) => s.trim()).filter(Boolean);
const port = Number(args.port);
const scenarioDir = resolve(HERE, "scenarios", args.scenario);
if (!existsSync(join(scenarioDir, "index.mjs"))) {
  console.error(`场景不存在: scenarios/${args.scenario}/(每个场景 = 含 index.mjs 的目录)`);
  process.exit(1);
}
const outDir = join(ROOT, "docs", "demo");
mkdirSync(outDir, { recursive: true });

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}
await assertPortFree(port);

console.log(`剧本: ${args.scenario}  locales: ${locales.join(", ")}`);
const runRoot = makeRunRoot();
console.log(`隔离环境: ${runRoot}/<locale> (每次执行全新;并发实例互不干扰,各自时间戳根)`);
const results = [];
try {
  for (const locale of locales) {
    results.push(await recordOnce(locale));
  }
} finally {
  // 收尾删自己的根(并发安全:只删本实例;崩溃残留由 makeRunRoot 过期清理兜底)
  rmSync(runRoot, { recursive: true, force: true });
}

console.log("\n产出:");
for (const r of results) {
  const kb = (statSync(r.gif).size / 1024).toFixed(0);
  console.log(`  ${r.locale.padEnd(6)} → ${r.gif.replace(ROOT + "/", "")}  (${r.seconds.toFixed(1)}s, ${kb}KB)`);
}

async function recordOnce(locale) {
  console.log(`\n=== ${locale} ===`);
  const home = join(runRoot, locale.replace(/[^a-zA-Z0-9-]/g, "-"));
  const bundle = await loadScenario(scenarioDir, locale);
  const ctx = setupBaseline({ home, realHome: homedir(), locale });
  applySeed(ctx, scenarioDir, bundle.spec, bundle.dict);

  const app = await launchApp({ appDir: ROOT, port, env: { HOME: home } });
  const framesDir = join(home, "frames");
  mkdirSync(framesDir, { recursive: true });
  try {
    await waitReady(app.page);
    await ensureLocale(app.page, locale);
    const resolve = await createResolver(app.page, locale);
    const rec = new Recorder(app.page, framesDir);
    for (const step of bundle.steps) {
      try {
        await execStep(step, { page: app.page, rec, resolve });
      } catch (err) {
        const diag = await app.page.evaluate(() => {
          const vis = (el) => el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false });
          const scope = [...document.querySelectorAll(".settings-content")].find(vis);
          return {
            lang: document.documentElement.lang,
            rippleLeftover: !!document.getElementById("__pi_demo_ripple__"),
            bodySnippet: document.body.innerText.slice(0, 150),
            scopeText: scope ? scope.innerText.slice(0, 400) : "NO SCOPE",
          };
        }).catch(() => null);
        console.error("  步骤失败现场:", JSON.stringify(diag), "step:", JSON.stringify(step));
        throw err;
      }
    }
    await killApp(app);
    const gif = join(outDir, `demo-${bundle.name}-${shortLocale(locale)}.gif`);
    await rec.toGif(gif);
    console.log(`  ${rec.entries.length} 帧, ${rec.totalSeconds.toFixed(1)}s → ${gif.replace(ROOT + "/", "")}`);
    if (!args["keep-frames"]) rmSync(framesDir, { recursive: true, force: true });
    return { locale, gif, seconds: rec.totalSeconds };
  } catch (err) {
    await killApp(app).catch(() => {});
    throw err;
  }
}

async function waitReady(page) {
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
  await page.waitForSelector("[data-sidebar-style]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
}

/** prefs 预设后校验 documentElement.lang;没生效就走真实 UI(设置 → 语言页)切换,不录帧。
 *
 *  坑(实测):i18n init 与 hydrate 竞态——init 先读 store 时拿到默认 zh-CN,prefs 预设的
 *  locale 只进了 store 没进 i18next。此时直点目标语言卡是 no-op:store 已是目标值,
 *  setCurrentLocale 不产生变化,订阅不触发 changeLanguage。故先切一个中间语言把 store
 *  改掉,再切回目标——两次真实变化,订阅触发两次。 */
async function ensureLocale(page, locale) {
  const current = await page.evaluate(() => document.documentElement.lang);
  if (current === locale) return;
  console.warn(`  页面 locale=${current},目标 ${locale},走语言页切换`);
  const resolveOld = await createResolver(page, current);
  const pivot = await page.evaluate((target) =>
    window.pi.i18n.list().then((list) => list.find((l) => l.id !== target)?.id ?? null), locale);
  if (!pivot) throw new Error("无中间语言可切换");

  await clickSilent(page, { i18nKey: "shell.settings", within: "[data-sidebar-style]" }, resolveOld);
  await clickSilent(page, { i18nKey: "settings.language", within: "[data-sidebar-style]" }, resolveOld);
  await clickSilent(page, { text: await localeCardLabel(page, pivot) }, resolveOld);
  await waitLang(page, pivot);
  await clickSilent(page, { text: await localeCardLabel(page, locale) }, resolveOld);
  await waitLang(page, locale);

  const resolveNew = await createResolver(page, locale);
  await clickSilent(page, { i18nKey: "shell.backToChat", within: "[data-sidebar-style]" }, resolveNew);
  await waitForDomIdle(page);
}

/** 语言卡显示名:各语言用自己 bundle 自称(common.locale.{id} 存于 resources[id],
 *  与 collectLocaleList 同源)——卡片文案不随 UI 语言变化,直接按字面文本定位。 */
async function localeCardLabel(page, locale) {
  return page.evaluate((id) =>
    window.pi.i18n.resources().then(({ resources }) => {
      const n = resources?.[id]?.common?.locale?.[id];
      return typeof n === "string" ? n : id;
    }), locale);
}

/** 轮询 documentElement.lang 直到切到目标(changeLanguage 异步,事件驱动替代固定 sleep)。 */
async function waitLang(page, locale, timeoutMs = 8000) {
  await page.waitForFunction((want) => document.documentElement.lang === want,
    { timeout: timeoutMs, polling: 100 }, locale);
  await waitForDomIdle(page);
}

async function clickSilent(page, target, resolve) {
  await waitForDomIdle(page);
  const loc = await locate(page, target, resolve);
  await page.mouse.click(loc.x, loc.y);
  await sleep(150);
}

async function execStep(step, ctx) {
  const { page, rec, resolve } = ctx;
  if (step.do === "hold") {
    await waitForDomIdle(page);
    await rec.frame(step.ms ?? 1000);
    return;
  }
  if (step.do === "hover") {
    await waitForDomIdle(page);
    const loc = await locate(page, step.target, resolve);
    await page.mouse.move(loc.x, loc.y);
    await sleep(300);
    return;
  }
  if (step.do === "drag") {
    await waitForDomIdle(page);
    const loc = await locate(page, step.target, resolve);
    console.log(`  drag → "${loc.label}" dx=${step.dx ?? 70}`);
    await rec.frame(step.preHold ?? 300);
    await ripple(page, rec, loc.x, loc.y);
    const dx = step.dx ?? 70;
    await page.mouse.move(loc.x, loc.y);
    await page.mouse.down();
    await page.mouse.move(loc.x + dx, loc.y, { steps: 10 });
    if (step.back) await page.mouse.move(loc.x, loc.y, { steps: 10 });
    await page.mouse.up();
    await sleep(200);
    await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 });
    await rec.frame(step.hold ?? 800);
    return;
  }
  if (step.do === "press") {
    // key 支持组合键:字符串"Control+v"拆成 down(Control)+press(v)+up(Control)
    const parts = step.key.split("+");
    for (const k of parts.slice(0, -1)) await page.keyboard.down(k);
    await page.keyboard.press(parts[parts.length - 1]);
    for (const k of parts.slice(0, -1)) await page.keyboard.up(k);
    await sleep(200);
    await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 });
    await rec.frame(step.hold ?? 900);
    return;
  }
  if (step.do === "click" || step.do === "point") {
    await waitForDomIdle(page);
    const target = step.target.groupToggleKey
      ? { ...step.target, groupToggle: resolve(step.target.groupToggleKey) }
      : step.target;
    const loc = await locate(page, target, resolve);
    console.log(`  ${step.do} → "${loc.label}" (${Math.round(loc.x)},${Math.round(loc.y)})`);
    await rec.frame(step.preHold ?? 450);
    await ripple(page, rec, loc.x, loc.y);
    if (step.do === "click") {
      await page.mouse.click(loc.x, loc.y);
      await sleep(150);
      await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 });
    }
    await rec.frame(step.hold ?? 1100);
    return;
  }
  if (step.do === "type") {
    await waitForDomIdle(page);
    const text = step.text;
    const loc = await locate(page, step.target, resolve);
    console.log(`  type → "${loc.label}" : ${text.slice(0, 30)}`);
    await rec.frame(step.preHold ?? 350);
    await ripple(page, rec, loc.x, loc.y);
    await typeText(page, loc, text, { submit: step.submit });
    await sleep(200);
    await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 });
    await rec.frame(step.hold ?? 900);
    return;
  }
  if (step.do === "select") {
    await waitForDomIdle(page);
    const loc = await locate(page, step.target, resolve);
    console.log(`  select → "${loc.label}"`);
    await rec.frame(step.preHold ?? 300);
    await selectAcross(page, loc, step);
    const selOk = () => page.evaluate(() => {
      const s = window.getSelection();
      return !!s && !s.isCollapsed && !!s.toString().trim();
    });
    if (!(await selOk())) await selectAcross(page, loc, { fromFx: 0, toFx: 1 });
    if (!(await selOk())) throw new Error("拖选后选区仍空");
    await rec.frame(step.hold ?? 900);
    return;
  }
  if (step.do === "clickRightAt") {
    await rightClick(page, step.x, step.y);
    await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 });
    await rec.frame(step.hold ?? 900);
    return;
  }
  if (step.do === "toolsOnlyReadOnly") {
    // 工具面板:除 read-only 外,所有 ON 的组逐个关掉(组构成是用户数据,不硬编码组名)。
    // ON 判定:开关 div 内联 background=var(--color-accent-success)(toggleSwitchStyle)。
    await waitForDomIdle(page);
    for (let i = 0; i < 12; i++) {
      const t = await page.evaluate(() => {
        const isVisible = (el) => el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false });
        const scope = [...document.querySelectorAll("[data-sidepanel-style]")].find(isVisible);
        if (!scope) return null;
        const spans = [...scope.querySelectorAll("span")].filter((el) => {
          let d = "";
          for (const n of el.childNodes) if (n.nodeType === 3) d += n.textContent;
          const name = d.trim();
          return name && name !== "read-only" && isVisible(el);
        });
        for (const span of spans) {
          const toggle = span.parentElement?.parentElement?.previousElementSibling;
          // read-only 行整体跳过(其徽标 span 也会映射到同一开关)
          if (toggle?.parentElement?.textContent?.includes("read-only")) continue;
          if (toggle && /accent-success/.test(toggle.style.background ?? "")) {
            const r = toggle.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, name: span.textContent.trim() };
          }
        }
        return null;
      });
      if (!t) break;
      console.log(`  toggle off → ${t.name}`);
      await ripple(page, rec, t.x, t.y);
      await page.mouse.click(t.x, t.y);
      await sleep(200);
      await waitForDomIdle(page, { quietMs: 400, timeoutMs: 5000 });
    }
    await rec.frame(step.hold ?? 1200);
    return;
  }
  if (step.do === "waitAgent") {
    console.log("  waitAgent …");
    try {
      await waitAgent(page, resolve("shell.stop"), step.opts);
    } catch (err) {
      // soft:预热步骤用——模型往返失败不致命(user 消息已在流里,后续定位器
      // 大多锚 user 消息),吞错继续,避免一条预热失败整场录制挂掉。
      if (!step.soft) throw err;
      console.warn(`  waitAgent 超时(soft,继续): ${err.message}`);
    }
    await rec.frame(step.hold ?? 1200);
    return;
  }
  throw new Error(`未知 step.do: ${step.do}`);
}

function shortLocale(locale) {
  if (locale === "zh-CN") return "zh";
  if (locale === "en") return "en";
  return locale.toLowerCase();
}
