#!/usr/bin/env node
// minimal 默认不装载 + 卸载 e2e —— 验证第 13/16 点的端到端:
// ① 默认(无 MHD_ENABLE_KERNELS):minimal 不在内核清单(enabled=false 默认不装载,§目标 16);
// ② 强制启用(MHD_ENABLE_KERNELS=minimal):minimal 进入清单(运行时覆盖,测试/演示用);
// ③ 卸载(删 manifest)后即使强制启用也缺面:app 照常启动、内核清单不含 minimal。
// 之后恢复 manifest。零真实 LLM、零外网。
// 用法: npm run build && node scripts/demo/minimal-uninstall.e2e.mjs [--port 9356] [--keep]
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

const MANIFEST = join(ROOT, "out", "main", "server", "kernel", "minimal", "plugin.json");
const MANIFEST_BAK = MANIFEST + ".bak";

let passed = 0;
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

/** 起 app 并读内核清单,返回 { app, kernelIds }。 */
async function launchAndReadKernelIds(extraEnv) {
  const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18464", ...extraEnv }, timeoutMs: 90000 });
  const page = app.page;
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  const kernelIds = await page.evaluate(() => window.kernel.kernelIds);
  return { app, kernelIds };
}

try {
  // ① 默认不装载(§目标 16):无 MHD_ENABLE_KERNELS 时 minimal 不在清单。
  {
    const { app, kernelIds } = await launchAndReadKernelIds({});
    ok(!kernelIds.includes("minimal"), `默认不装载:内核清单不含 minimal(实际 ${JSON.stringify(kernelIds)})`);
    ok(kernelIds.includes("pi") && kernelIds.includes("dsh"), `pi/dsh 仍装载(实际 ${JSON.stringify(kernelIds)})`);
    ok(true, "默认配置下 app 照常启动(composer 就绪,不崩)");
    await killApp(app);
  }

  // ② 强制启用:MHD_ENABLE_KERNELS=minimal 时 minimal 进入清单(运行时覆盖)。
  {
    const { app, kernelIds } = await launchAndReadKernelIds({ MHD_ENABLE_KERNELS: "minimal" });
    ok(kernelIds.includes("minimal"), `强制启用:内核清单含 minimal(实际 ${JSON.stringify(kernelIds)})`);
    await killApp(app);
  }

  // ③ 卸载:删 manifest 后,即使强制启用也缺面,app 照常启动。
  if (!existsSync(MANIFEST)) throw new Error(`manifest 不存在(需先 build): ${MANIFEST}`);
  renameSync(MANIFEST, MANIFEST_BAK);
  let restored = false;
  try {
    const { app: app3, kernelIds } = await launchAndReadKernelIds({ MHD_ENABLE_KERNELS: "minimal" });
    ok(!kernelIds.includes("minimal"), `卸载后缺面:内核清单不含 minimal(实际 ${JSON.stringify(kernelIds)})`);
    ok(kernelIds.includes("pi") && kernelIds.includes("dsh"), "卸载 minimal 后 pi/dsh 照常装载");
    ok(true, "卸载 minimal 后 app 照常启动(composer 就绪,不崩)");
    await killApp(app3);
  } finally {
    if (existsSync(MANIFEST_BAK)) { renameSync(MANIFEST_BAK, MANIFEST); restored = true; }
  }
  ok(restored, "manifest 已恢复(不影响后续 build/e2e)");

  console.log(`\n✅ PASS: ${passed} 项断言(minimal 默认不装载 + 卸载,零真实 LLM)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (existsSync(MANIFEST_BAK)) renameSync(MANIFEST_BAK, MANIFEST);
  process.exit(1);
}
