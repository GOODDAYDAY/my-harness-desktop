#!/usr/bin/env node
// demo 录制入口 —— 一套剧本,每个 locale 跑一遍,各出一条 GIF(README 双语物料)。
//
// 用法:
//   npm run build && node scripts/demo/record.mjs
//   node scripts/demo/record.mjs --locales zh-CN,en --scenario basic-tour [--port 9222] [--keep-frames]
//
// 流水线(每 locale):打补丁 prefs(locale + 基线主题)→ 拉起 electron(CDP)→ 校验 locale
// (不一致走语言页 UI 兜底切换)→ 逐步执行剧本(涟漪 + 截帧)→ kill → ffmpeg 合成 GIF。
// 全部跑完恢复 prefs 快照——用户桌面偏好零污染。
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, launchApp, killApp } from "./lib/app.mjs";
import { snapshotPrefs, patchPrefs, restorePrefs } from "./lib/prefs.mjs";
import { createResolver } from "./lib/i18n.mjs";
import { locate } from "./lib/locate.mjs";
import { Recorder } from "./lib/recorder.mjs";
import { ripple } from "./lib/ripple.mjs";
import { sleep, waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// 基线主题:两遍录制从同一外观起步(也是应用 store 默认主题),切换效果对两遍都可见
const BASELINE_THEME = "chatgpt-dark";

const { values: args } = parseArgs({
  options: {
    locales: { type: "string", default: "zh-CN,en" },
    scenario: { type: "string", default: "basic-tour" },
    port: { type: "string", default: "9222" },
    "keep-frames": { type: "boolean", default: false },
  },
});

const locales = args.locales.split(",").map((s) => s.trim()).filter(Boolean);
const port = Number(args.port);
const scenario = (await import(`./scenarios/${args.scenario}.mjs`)).default;
const outDir = join(ROOT, "docs", "demo");
mkdirSync(outDir, { recursive: true });

if (!existsSync(join(ROOT, "out", "main", "index.js"))) {
  console.error("未找到 out/ 构建产物,先跑: npm run build");
  process.exit(1);
}
await assertPortFree(port);

console.log(`剧本: ${scenario.name}(${scenario.steps.length} 步)  locales: ${locales.join(", ")}`);
const snapshot = snapshotPrefs();
const results = [];
try {
  for (const locale of locales) {
    results.push(await recordOnce(locale));
  }
} finally {
  restorePrefs(snapshot);
}

console.log("\n产出:");
for (const r of results) {
  const kb = (statSync(r.gif).size / 1024).toFixed(0);
  console.log(`  ${r.locale.padEnd(6)} → ${r.gif.replace(ROOT + "/", "")}  (${r.seconds.toFixed(1)}s, ${kb}KB)`);
}

async function recordOnce(locale) {
  console.log(`\n=== ${locale} ===`);
  patchPrefs({ currentLocale: locale, currentThemeId: BASELINE_THEME });
  const app = await launchApp({ appDir: ROOT, port });
  const framesDir = mkdtempSync(join(tmpdir(), `pi-demo-${locale}-`));
  try {
    await waitReady(app.page);
    await ensureLocale(app.page, locale);
    const resolve = await createResolver(app.page, locale);
    const rec = new Recorder(app.page, framesDir);
    for (const step of scenario.steps) {
      try {
        await execStep(step, { page: app.page, rec, resolve });
      } catch (err) {
        const diag = await app.page.evaluate(() => ({
          lang: document.documentElement.lang,
          scopes: [...document.querySelectorAll("[data-sidebar-style]")].map((s) =>
            s.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false })),
          rippleLeftover: !!document.getElementById("__pi_demo_ripple__"),
          bodySnippet: document.body.innerText.slice(0, 200),
        })).catch(() => null);
        console.error("  步骤失败现场:", JSON.stringify(diag, null, 1));
        throw err;
      }
    }
    await killApp(app);
    const gif = join(outDir, `demo-${shortLocale(locale)}.gif`);
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
  const label = await page.evaluate((id) =>
    window.pi.i18n.resources().then(({ resources }) => {
      const n = resources?.[id]?.common?.locale?.[id];
      return typeof n === "string" ? n : id;
    }), locale);
  return label;
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
  if (step.do === "click") {
    await waitForDomIdle(page);
    const loc = await locate(page, step.target, resolve);
    console.log(`  click → "${loc.label}" (${Math.round(loc.x)},${Math.round(loc.y)})`);
    await rec.frame(step.preHold ?? 450);
    await ripple(page, rec, loc.x, loc.y);
    await page.mouse.click(loc.x, loc.y);
    await sleep(150);
    await waitForDomIdle(page, { quietMs: 500, timeoutMs: 8000 });
    await rec.frame(step.hold ?? 1100);
    return;
  }
  throw new Error(`未知 step.do: ${step.do}`);
}

function shortLocale(locale) {
  if (locale === "zh-CN") return "zh";
  if (locale === "en") return "en";
  return locale.toLowerCase();
}
