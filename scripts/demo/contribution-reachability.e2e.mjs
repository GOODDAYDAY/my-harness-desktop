#!/usr/bin/env node
// 贡献可达性对账 e2e —— manifest 声明的贡献 ↔ 界面上真的能到达（r62）。
//
// ## 守什么
//
// 「声明了却渲染不出来」是**功能漂移**里最难发现的一类：manifest 写着有 sidePanel，
// 用户却永远打不开它；不报错、不变红、正向剧本也撞不到（因为没人会去点一个不存在的开关）。
// 本剧本把两侧都 dump 出来做**双向差集**：
//   · 声明侧：扫全部 `plugin.json` 的 `contributes.sidePanel` 与 `contributes.settings`
//   · 渲染侧：真机里的右面板开关（`button[aria-pressed]` 的 aria-label）与设置页条目
//     （`[data-settings-id]`）
// 两个方向都要空：声明了没渲染 = 不可达；渲染了没声明 = 幽灵贡献。
//
// ## ⚠ 必须先解除 disabledPlugins，否则会得到**假缺陷**（r62 实踩）
//
// 隔离基线 `scripts/demo/lib/home.mjs:132` 自己写了
// `disabledPlugins: ["goody-hao", "sub-agent"]`。首跑时 sub-agent 的两个 sidePanel
// （`sub-agents-panel` / `sub-agent-dialog`）因此不渲染，看起来像"声明了却没有开关"的产品缺陷——
// 排查链走了四层（真机 dump 开关 → 壳 `slots.sidePanel()` → 插件 `state` →
// `lifecycle/index.ts` 的 `getPluginState`）才追到是**种子文件**禁用的。
// 启用后重跑：声明 13 = 渲染 13，两侧差集均为 0。
//
// > 通则：做"声明 ↔ 实际"对账前，先确认**被测对象处于启用态**。
// > 测试基线为了别的用途（例如让某个插件不干扰冒烟）而禁用插件是完全合理的，
// > 但复用那个基线做可达性对账就会把"基线的选择"误读成"产品的缺陷"。
//
// 零 token：不进会话、不发消息。
//
// 用法: npm run build && node scripts/demo/contribution-reachability.e2e.mjs [--port 9490] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9490" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? `（现场：${JSON.stringify(detail)?.slice(0, 300)}）` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ── 声明侧：扫全部 manifest ──
const declaredPanels = [];
const declaredSettings = [];
const walkManifests = (d) => {
  for (const n of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, n.name);
    if (n.isDirectory()) { if (n.name !== "node_modules" && !n.name.startsWith(".")) walkManifests(f); }
    else if (n.name === "plugin.json") {
      const j = JSON.parse(readFileSync(f, "utf-8"));
      const c = j.contributes ?? {};
      for (const sp of c.sidePanel ?? []) declaredPanels.push({ id: sp.id, label: sp.label, plugin: j.id });
      for (const st of c.settings ?? []) declaredSettings.push({ id: st.id, plugin: j.id });
    }
  }
};
walkManifests(join(ROOT, "src/plugins"));
walkManifests(join(ROOT, "test-plugins"));

// ── 隔离 HOME ──
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
seedTestPlugins(ctx.dataRoot);

// ⚠ 解除基线的插件禁用（见文件头说明）：可达性对账必须在"全部启用"的前提下做。
const pmFile = join(ctx.dataRoot, "config", "plugin-manager.json");
const pm = JSON.parse(readFileSync(pmFile, "utf-8"));
const seededDisabled = [...(pm.disabledPlugins ?? [])];
pm.disabledPlugins = [];
writeFileSync(pmFile, JSON.stringify(pm, null, 2));

const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18417" }, timeoutMs: 90000 });
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 1200, timeoutMs: 25000 });

  console.log(`\n── 右面板：sidePanel 贡献 ↔ 开关 ──`);
  console.log(`  · 基线原本禁用了 ${JSON.stringify(seededDisabled)}，本剧本已解除`);
  const toggles = await page.evaluate(() => [...document.querySelectorAll("button[aria-pressed]")].map((b) => b.getAttribute("aria-label")));
  const inactive = await page.evaluate(async () => (await window.kernel.plugins.list()).filter((p) => p.state !== "active").map((p) => `${p.id}:${p.state}`));
  console.log(`  · 声明 ${declaredPanels.length} 个 sidePanel；渲染 ${toggles.length} 个开关；非 active 插件 ${JSON.stringify(inactive)}`);
  ok(inactive.length === 0, `所有插件都处于 active（否则"没渲染"可能只是被禁用，对账无意义；实际 ${JSON.stringify(inactive)}）`);
  ok(declaredPanels.length >= 13, `声明侧至少 13 个 sidePanel（r62 实测 13；少了说明扫描路径坏了）`);
  ok(toggles.length >= 13, `渲染侧至少 13 个开关（实际 ${toggles.length}）`);
  const missingPanels = declaredPanels.filter((d) => !toggles.includes(d.label));
  ok(missingPanels.length === 0, `**声明的 sidePanel 全都有开关**（不可达 ${missingPanels.length} 个）`, missingPanels);
  const ghostPanels = toggles.filter((l) => !declaredPanels.some((d) => d.label === l));
  ok(ghostPanels.length === 0, `**没有未声明的幽灵开关**（${ghostPanels.length} 个）`, ghostPanels);

  console.log(`\n── 设置页：settings 贡献 ↔ 条目 ──`);
  await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]')?.click());
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 20000 }).catch(() => {});
  const entries = await page.evaluate(() => [...document.querySelectorAll("[data-settings-id]")].map((e) => e.getAttribute("data-settings-id")));
  console.log(`  · 声明 ${declaredSettings.length} 个 settings 条目；渲染 ${entries.length} 个`);
  const missingSettings = declaredSettings.filter((d) => !entries.includes(d.id));
  ok(missingSettings.length === 0, `**声明的设置条目全都出现**（不可达 ${missingSettings.length} 个）`, missingSettings);
  const ghostSettings = entries.filter((e) => !declaredSettings.some((d) => d.id === e));
  ok(ghostSettings.length === 0, `**没有未声明的幽灵设置条目**（${ghostSettings.length} 个）`, ghostSettings);

  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await page.screenshot({ path: join(runRoot, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await killApp(app);
}

console.log(`\n✅ PASS: ${passed} 项断言（贡献可达性对账：sidePanel ${declaredPanels.length} 个 + settings ${declaredSettings.length} 个，双向差集为空）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
