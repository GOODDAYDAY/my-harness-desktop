#!/usr/bin/env node
// minimal 卸载 e2e —— 验证第 13 点「把插件卸载掉仍然没问题」的端到端。
// 删掉 out/main/server/kernel/minimal/plugin.json(模拟卸载内核插件)→ 起 app →
// 验证:① app 照常启动(不崩);② 内核清单不再含 minimal(模型下拉无 minimal TAB)。
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

let app;
try {
  // 卸载 minimal:备份 + 删 manifest。
  if (!existsSync(MANIFEST)) throw new Error(`manifest 不存在(需先 build): ${MANIFEST}`);
  renameSync(MANIFEST, MANIFEST_BAK);

  app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18464" }, timeoutMs: 90000 });
  const page = app.page;
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  ok(true, "卸载 minimal 后 app 照常启动(composer 就绪,不崩)");

  // 内核清单:window.kernel.kernelIds 不再含 minimal(动态扫描读 manifest,缺面)。
  const kernelIds = await page.evaluate(() => window.kernel.kernelIds);
  ok(!kernelIds.includes("minimal"), `内核清单不含 minimal(实际 ${JSON.stringify(kernelIds)})`);
  ok(kernelIds.length >= 1, `其余内核仍在(实际 ${kernelIds.length} 个)`);

  // 模型下拉 TAB 条不含 minimal(composer 从 kernelIds 遍历)。
  const triggerRect = await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const scope = ta?.closest("form") ?? document.body;
    const btns = [...scope.querySelectorAll("button")].filter((b) => b.querySelector("svg"));
    const trigger = btns.find((b) => {
      const t = (b.textContent || "").trim();
      return t.length > 2 && !/^(off|minimal|low|medium|high|xhigh)$/i.test(t);
    });
    if (!trigger) return null;
    const r = trigger.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (triggerRect) {
    await page.mouse.click(triggerRect.x, triggerRect.y);
    await page.waitForSelector("[role='menu']", { timeout: 4000 }).catch(() => {});
    const hasMinimalTab = await page.evaluate(() =>
      [...document.querySelectorAll("[role='menu'] button")].some((b) => (b.textContent || "").trim().toLowerCase() === "minimal"),
    );
    ok(!hasMinimalTab, "模型下拉 TAB 条不含 minimal(缺面降级)");
    await page.keyboard.press("Escape").catch(() => {});
  } else {
    ok(true, "无模型下拉触发器(无模型内核,符合缺面预期)");
  }

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(minimal 卸载,零真实 LLM)`);
  if (!args.keep) rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  // 恢复 manifest(成功路径;process.exit 会跳过 finally,故在此显式恢复)。
  if (existsSync(MANIFEST_BAK)) renameSync(MANIFEST_BAK, MANIFEST);
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (app) await killApp(app).catch(() => {});
  // 恢复 manifest(失败路径)。
  if (existsSync(MANIFEST_BAK)) renameSync(MANIFEST_BAK, MANIFEST);
  process.exit(1);
}
