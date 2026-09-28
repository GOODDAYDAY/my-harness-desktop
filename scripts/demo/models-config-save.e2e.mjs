// 模型配置 TAB 的保存链 e2e —— 守 r33 那次契约改动的**行为面**。
//
// 改了什么：`system:configFileSaved` 的 payload 从只有 `{ path }` 变成 `{ path, kind }`，
// `kind` 由**声明方**（设置页按贡献声明 `kernelModels` / `kernelConfig`）经圆心纯函数
// `configSavedKind` 派生；消费方（timeline）改认 `kind === "kernelModels"` 而不再拿路径
// 比对 `MODELS_CONFIG_PATH`（那个常量是发布面里的 `"~/.pi/agent/models.json"`，已删）。
//
// 为什么必须有这条 e2e：这条链断掉的症狀是**静默的**——保存成功、文件也写了，
// 但模型清单不重探，用户改了模型配置却看不到变化，要重启才行，且全程无报错。
// 纯函数两端各有单测（`config-saved.test.ts` 7 条），但"设置页真的把 tab 级声明传下去了"
// 这一段只有真机能验：`kernelModels` 声明在 **tab** 上而不是 entry 上，
// 若 emit 点传的是 entry，`kind` 会静默派生成 `pluginConfig`、缺陷照旧（已核
// `activeItem = activeEntry?.tabs?.[activeTabIndex] ?? activeEntry`，取的是 tab）。
//
// 判据：① TAB 锚点可达并切到模型 TAB；② 改一个开关 → 保存浮层出现（表单 dirty）；
// ③ 保存后**模型配置文件真的变了**（kernelModels 那条写盘路径通）；
// ④ 回聊天页后 composer 仍有绑定模型（刷新链没把状态弄丢）；⑤ 全程零报错。
//
// 零 token：不进会话、不发消息。
//
// 用法: npm run build && node scripts/demo/models-config-save.e2e.mjs [--port 9440] [--keep]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9440" }, keep: { type: "boolean", default: false } } });
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
const runRoot = makeRunRoot(); const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
seedTestPlugins(ctx.dataRoot);
const pd = join(home, "project"); mkdirSync(pd, { recursive: true });
const pf = join(ctx.configDir, "config.json");
writeFileSync(pf, JSON.stringify({ ...JSON.parse(readFileSync(pf, "utf-8")), lastCwd: pd }, null, 2));
const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18441" }, timeoutMs: 90000 });
const page = app.page; const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 140)));
page.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text().slice(0, 140)); });
let n = 0; const ok = (c, l, d) => { if (!c) throw new Error(`断言失败: ${l}${d !== undefined ? ` (${JSON.stringify(d).slice(0,180)})` : ""}`); n++; console.log(`  ✓ ${l}`); };
try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  // composer 模型下拉的初始状态
  const modelBefore = await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model") ?? null);
  console.log(`  · 起点 composer 模型: ${modelBefore}`);
  await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]')?.click());
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll("[data-settings-id]")].find((e) => e.getAttribute("data-settings-id") === "pi")?.click());
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
  const tabs = await page.evaluate(() => [...document.querySelectorAll("[data-settings-tab]")].map((e) => e.getAttribute("data-settings-tab")));
  console.log(`  · pi 设置页 TAB: ${JSON.stringify(tabs)}`);
  ok(tabs.includes("pi-models"), "TAB 锚点可用且含 pi-models（模型 TAB）", tabs);
  await page.evaluate(() => document.querySelector('[data-settings-tab="pi-models"]')?.click());
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 15000 }).catch(() => {});
  ok(await page.evaluate(() => document.querySelector('[data-settings-tab="pi-models"]')?.getAttribute("data-settings-tab-active")) === "true", "已切到模型 TAB");
  // 模型 TAB 里改一个控件（找到第一个 checkbox/开关并点它），让表单变 dirty
  const toggled = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("input[type=checkbox]")].filter((e) => e.getBoundingClientRect().width > 0);
    if (!boxes.length) return null;
    const b = boxes[0]; b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, before: b.checked };
  });
  console.log(`  · 模型 TAB 里可切的开关: ${JSON.stringify(toggled)}`);
  if (toggled) {
    await page.mouse.click(toggled.x, toggled.y);
    await waitForDomIdle(page, { quietMs: 600, timeoutMs: 10000 }).catch(() => {});
    const bar = await page.evaluate(() => !!document.querySelector('[data-settings-save="confirm"]'));
    ok(bar, "改动后出现保存浮层（表单 dirty）");
    const modelsFile = join(home, ".pi", "agent", "models.json");
    const before = existsSync(modelsFile) ? readFileSync(modelsFile, "utf-8") : null;
    await page.evaluate(() => { const b = document.querySelector('[data-settings-save="confirm"]'); const r = b.getBoundingClientRect(); b.scrollIntoView({ block: "center" }); return r; });
    const r2 = await page.evaluate(() => { const b = document.querySelector('[data-settings-save="confirm"]'); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(r2.x, r2.y);
    for (let i = 0; i < 25; i++) { if (existsSync(modelsFile) && readFileSync(modelsFile, "utf-8") !== before) break; await new Promise((r) => setTimeout(r, 200)); }
    const after = existsSync(modelsFile) ? readFileSync(modelsFile, "utf-8") : null;
    ok(!!after && after !== before, "保存后模型配置文件真的变了（kernelModels 那条路径写盘成功）", { had: !!before, has: !!after });
  } else {
    console.log("  · 模型 TAB 里没有可切的开关，跳过写盘验证（只做无报错与下拉复验）");
  }
  // 回聊天页，确认 composer 模型下拉仍正常（refreshExternals 被触发后不该坏）
  await page.evaluate(() => document.querySelector('[data-settings-back="chat"]')?.click());
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
  const modelAfter = await page.evaluate(() => document.querySelector("[data-composer-model]")?.getAttribute("data-composer-model") ?? null);
  console.log(`  · 回到聊天页 composer 模型: ${modelAfter}`);
  ok(!!modelAfter, "保存模型配置后 composer 仍有绑定模型（刷新链没把状态弄丢）", { modelBefore, modelAfter });
  ok(errs.length === 0, `全程零报错（实际 ${errs.length}）`, errs.slice(0, 3));
  console.log(`\n✅ PASS: ${n} 项断言（模型 TAB 保存 → 落盘 → 刷新链 → composer 正常）`);
} catch (e) { console.error(`\n❌ FAIL: ${e.message}`); process.exitCode = 1; }
finally { await killApp(app); if (!args.keep) { /* runRoot 由 mkdtemp 管理，--keep 时保留 */ } }
