#!/usr/bin/env node
// 自定义内核目录的 prefs 往返 e2e —— 守 r32 那次改动的**行为面**。
//
// 改了什么：`customCliDir`（隐式 pi 的）与 `dshCustomCliDir` 曾是 application 层 `Prefs`
// 接口上的**按内核名分的字段**（§6.3 检验④ 禁的形态：加第四个内核要改中层类型）。
// 现已移除，改走 `JsonPrefsStore` 的**动态键 API**——内核插件自定键名
// （圆心 `kernel-plugin.ts`：「核心不硬编码 key 名，key 由插件自定」），键不进 `Prefs`、
// 装配点不再 `key as keyof Prefs` 强转。**持久化格式没变**（盘上仍是那两个键名），所以无需迁移。
//
// 但"类型层重构 + 读写换了 API"必须验行为没变，否则是纸面正确。判据是完整一条链：
//   ① 在 UI 里填一个**能通过校验**的目录并应用；
//   ② 盘上的 `config.json` 里出现该内核插件自定的键与值（**键名由插件定，壳不认识它**）；
//   ③ **重启后**输入框显示同一个值（证明读回走的是同一条动态键路径）；
//   ④ 清除后盘上的值回到空（证明写路径也通）。
// 只验①会漏掉"界面改了但没落盘"；只验②会漏掉"落盘了但读不回"（那正是换 API 最容易断的地方）。
//
// ⚠ apply 会先校验目录（pi 找 `dist/cli.js`，dsh 找 `apps/cli/lib/bin.js`），
//   所以必须造一个能通过校验的假目录，否则拿到的是"校验失败"而不是"写入成功"，
//   看起来像 prefs 坏了。
//
// 零 token：不进会话、不发消息。
//
// 用法: npm run build && node scripts/demo/kernel-custom-dir.e2e.mjs [--port 9430] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9430" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? `（现场：${JSON.stringify(detail)?.slice(0, 220)}）` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
// 假的内核目录：pi 的 resolveCustomCli 认 `dist/cli.js`
const fakeKernel = join(home, "fake-kernel");
mkdirSync(join(fakeKernel, "dist"), { recursive: true });
writeFileSync(join(fakeKernel, "dist", "cli.js"), "// 假 CLI 入口，只为通过 resolveCustomCli 的校验\n");
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
const readPrefs = () => (existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, "utf-8")) : {});

let app = null;
let page = null;
const boot = async (port, mhdPort) => {
  app = await launchApp({ appDir: ROOT, port, env: { HOME: home, MHD_PORT: mhdPort }, timeoutMs: 90000 });
  page = app.page;
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
};

/** 进设置页 → pi 条目 → 内核版本 TAB（自定义目录控件在那里）。 */
const gotoCustomDir = async () => {
  await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]')?.click());
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-settings-id]")].find((e) => e.getAttribute("data-settings-id") === "pi");
    el?.click();
  });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 15000 }).catch(() => {});
  await page.waitForSelector("[data-kernel-custom-dir]", { timeout: 10000 });
};

const clickAnchor = async (sel) => {
  await page.waitForSelector(sel, { timeout: 8000 });
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s);
    el.scrollIntoView({ block: "center" });
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, disabled: el.disabled ?? false };
  }, sel);
  if (!(r.w > 0)) throw new Error(`目标不可见: ${sel}`);
  if (r.disabled) return false;
  await page.mouse.click(r.x, r.y);
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 12000 }).catch(() => {});
  return true;
};

try {
  await boot(Number(args.port), "18445");
  await gotoCustomDir();

  const before = readPrefs();
  console.log(`\n── 起点 ──\n  · config.json 里与自定义目录相关的键：${JSON.stringify(Object.keys(before).filter((k) => /cli|Cli/i.test(k)))}`);

  // ① 填入能通过校验的目录并应用
  console.log("\n── ① 设置自定义内核目录 ──");
  await page.click("[data-kernel-custom-dir]");
  await page.keyboard.down("Meta"); await page.keyboard.press("KeyA"); await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(fakeKernel, { delay: 6 });
  const typed = await page.evaluate(() => document.querySelector("[data-kernel-custom-dir]")?.value ?? null);
  ok(typed === fakeKernel, `输入框里确实是要设的目录`, { typed, want: fakeKernel });
  const applied = await clickAnchor("[data-kernel-custom-dir-apply]");
  ok(applied, "应用按钮可点（dirty 后不该 disabled）");
  // 等落盘：prefs 的 set 是 fire-and-forget 异步写盘，所以轮询**文件**而不是赌固定 sleep
  await page.waitForFunction(
    (want) => true,
    { timeout: 100 },
  ).catch(() => {});
  for (let i = 0; i < 20; i++) {
    if (Object.values(readPrefs()).includes(fakeKernel)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // ② 盘上出现该内核插件自定的键
  const afterSet = readPrefs();
  const cliKeys = Object.keys(afterSet).filter((k) => /cli|Cli/i.test(k));
  console.log(`  · 落盘后相关键：${JSON.stringify(cliKeys.map((k) => [k, afterSet[k]]))}`);
  ok(cliKeys.length >= 1, `② config.json 里出现了自定义目录键（**键名由内核插件自定，壳不认识它**）`, cliKeys);
  const keyName = cliKeys.find((k) => afterSet[k] === fakeKernel) ?? null;
  ok(!!keyName, `② 该键的值正是刚设的目录（实际键=${keyName}）`, afterSet);
  // 反馈区应报成功而不是校验失败
  const feedback = await page.evaluate(() => {
    const el = document.querySelector("[data-kernel-custom-dir]")?.closest("div")?.parentElement;
    return (el?.innerText ?? "").slice(0, 200);
  });
  ok(!/失败|无效|不存在|error/i.test(feedback ?? ""), `② UI 未报校验失败（目录是能通过 resolveCustomCli 的）`, feedback?.slice(0, 120));

  // ③ 重启后读回
  console.log("\n── ③ 重启后读回 ──");
  await killApp(app); app = null;
  await boot(Number(args.port) + 1, "18444");
  await gotoCustomDir();
  const shown = await page.evaluate(() => document.querySelector("[data-kernel-custom-dir]")?.value ?? null);
  console.log(`  · 重启后输入框显示：${JSON.stringify(shown)}`);
  ok(shown === fakeKernel, `③ **重启后输入框显示同一个目录**（读回走的是同一条动态键路径）`, { shown, want: fakeKernel });

  // ④ 清除
  console.log("\n── ④ 清除 ──");
  const cleared = await clickAnchor("[data-kernel-custom-dir-clear]");
  ok(cleared, "清除按钮在已设置时可点");
  await new Promise((r) => setTimeout(r, 900));
  const afterClear = readPrefs();
  console.log(`  · 清除后该键的值：${JSON.stringify(afterClear[keyName])}`);
  ok(afterClear[keyName] === "" || afterClear[keyName] === undefined,
    `④ 清除后盘上的值回到空（写路径也通；实际 ${JSON.stringify(afterClear[keyName])}）`);
  const shownAfter = await page.evaluate(() => document.querySelector("[data-kernel-custom-dir]")?.value ?? null);
  ok(!shownAfter, `④ 输入框也清空了（实际 ${JSON.stringify(shownAfter)}）`);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (page) await page.screenshot({ path: join(runRoot, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await killApp(app);
}

console.log(`\n✅ PASS: ${passed} 项断言（自定义内核目录的 prefs 往返：设置 → 落盘 → 重启读回 → 清除）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
