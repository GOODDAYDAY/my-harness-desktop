#!/usr/bin/env node
// 内核插件「一个内核 = 一个插件」的端到端验收（§目标 11/12/13/16）。
//
// 验的是这一条硬要求：**把插件卸载掉，仍然没问题**——而且卸载的是**一个目录**，
// 内核与它的 desktop 对接面**同生共死**：
//   ① 默认(无 MHD_ENABLE_KERNELS)：minimal 的 kernel 块 enabled=false ⇒ 内核清单不含 minimal，
//      **且设置页也没有 Minimal 入口**（没有内核却显示它的设置页，只会得到一堆报错）；
//   ② 强制启用(MHD_ENABLE_KERNELS=minimal)：内核进入清单，**且 Minimal 设置入口同时出现**；
//   ③ 卸载 = 删这一个插件的 plugin.json：即使强制启用也缺面、设置入口消失，pi/dsh 照常，app 不崩。
// 之后恢复 manifest。零真实 LLM、零外网。
//
// 用法: npm run build && node scripts/demo/kernel-plugin-uninstall.e2e.mjs [--port 9356] [--keep]
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9356" }, keep: { type: "boolean", default: false } } });

// 卸载的对象 = 内核插件自己的 manifest（内核面与对接面共用这一份）。
const MANIFEST = join(ROOT, "src", "plugins", "kernels", "minimal", "plugin.json");
const MANIFEST_BAK = MANIFEST + ".bak";

let passed = 0;
/** 当前在跑的 app（失败路径也要 kill：泄漏实例会霸占 CDP 端口，毒化后续运行）。 */
let liveApp = null;
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

/** 起 app：读内核清单 + 设置入口 id 清单 + **真实打开设置页后**导航里的锚点清单。 */
async function launchAndRead(extraEnv) {
  const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18464", ...extraEnv }, timeoutMs: 90000 });
  liveApp = app;
  const page = app.page;
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  const kernelIds = await page.evaluate(() => window.kernel.kernelIds);
  // 设置入口清单来自壳插件注册表（服务端事实），不受"用户没点过设置页"影响。
  const settingsIds = await page.evaluate(async () => {
    const items = await window.kernel.settings.list();
    return items.map((i) => i.id);
  });
  // DOM 面复核：真实开设置页（⌘,），读导航里的**锚点**（服务端清单 ≠ 渲染出来）。
  await page.keyboard.down("Meta"); await page.keyboard.press(","); await page.keyboard.up("Meta");
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 8000 }).catch(() => {});
  const navIds = await page.evaluate(() =>
    [...document.querySelectorAll("[data-settings-id]")].map((el) => el.getAttribute("data-settings-id")));
  return { app, page, kernelIds, settingsIds, navIds };
}

try {
  // ① 默认：内核不装载 ⇒ 对接面也不装载（两面同生共死）。
  {
    const { app, kernelIds, settingsIds, navIds } = await launchAndRead({});
    ok(!kernelIds.includes("minimal"), `默认不装载：内核清单不含 minimal（实际 ${JSON.stringify(kernelIds)}）`);
    ok(kernelIds.includes("pi") && kernelIds.includes("dsh"), `pi/dsh 仍装载（实际 ${JSON.stringify(kernelIds)}）`);
    ok(settingsIds.includes("pi") && settingsIds.includes("dsh"), `pi/dsh 的设置入口在（实际 ${JSON.stringify(settingsIds)}）`);
    ok(!settingsIds.includes("minimal"), `minimal 未装载 ⇒ 设置页也没有 Minimal 入口（实际 ${JSON.stringify(settingsIds)}）`);
    ok(navIds.length > 0, `设置导航渲染出可定位的锚点（实际 ${navIds.length} 个：${JSON.stringify(navIds.slice(0, 6))}…）`);
    ok(!navIds.includes("minimal"), "DOM 面复核：导航里没有 Minimal 锚点");
    ok(true, "默认配置下 app 照常启动（composer 就绪，不崩）");
    await killApp(app);
    liveApp = null;
  }

  // ② 强制启用：内核与它的设置入口**一起**出现。
  {
    const { app, kernelIds, settingsIds, navIds } = await launchAndRead({ MHD_ENABLE_KERNELS: "minimal" });
    ok(kernelIds.includes("minimal"), `强制启用：内核清单含 minimal（实际 ${JSON.stringify(kernelIds)}）`);
    ok(settingsIds.includes("minimal"), `强制启用：设置入口同时出现（实际 ${JSON.stringify(settingsIds)}）`);
    ok(navIds.includes("minimal"), `DOM 面复核：设置导航里渲染出 Minimal 锚点（实际 ${JSON.stringify(navIds)}）`);
    await killApp(app);
    liveApp = null;
  }

  // ③ 卸载：删这一个插件 manifest ⇒ 内核缺面 + 对接面消失，其余内核照常。
  if (!existsSync(MANIFEST)) throw new Error(`manifest 不存在：${MANIFEST}`);
  renameSync(MANIFEST, MANIFEST_BAK);
  let restored = false;
  try {
    const { app: app3, kernelIds, settingsIds, navIds } = await launchAndRead({ MHD_ENABLE_KERNELS: "minimal" });
    ok(!kernelIds.includes("minimal"), `卸载后缺面：即使强制启用，内核清单也不含 minimal（实际 ${JSON.stringify(kernelIds)}）`);
    ok(!settingsIds.includes("minimal"), `卸载后设置入口一起消失（实际 ${JSON.stringify(settingsIds)}）`);
    ok(!navIds.includes("minimal"), "DOM 面复核：卸载后导航里也没有 Minimal 锚点");
    ok(kernelIds.includes("pi") && kernelIds.includes("dsh"), "卸载 minimal 后 pi/dsh 照常装载");
    ok(settingsIds.includes("pi") && settingsIds.includes("dsh"), "卸载 minimal 后 pi/dsh 的设置入口照常");
    ok(true, "卸载后 app 照常启动（composer 就绪，不崩）");
    await killApp(app3);
    liveApp = null;
  } finally {
    if (existsSync(MANIFEST_BAK)) { renameSync(MANIFEST_BAK, MANIFEST); restored = true; }
  }
  ok(restored, "manifest 已恢复（不影响后续 build/e2e）");

  console.log(`\n✅ PASS: ${passed} 项断言（一个内核 = 一个插件：默认不装载 / 强制启用 / 卸载同生共死，零真实 LLM）`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (existsSync(MANIFEST_BAK)) renameSync(MANIFEST_BAK, MANIFEST);
  if (liveApp) await killApp(liveApp).catch(() => {});
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(1);
}
