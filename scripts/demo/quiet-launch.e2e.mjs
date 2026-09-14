#!/usr/bin/env node
// 测试静默 e2e —— 真 app 里验"跑测试不抢用户焦点"(CLAUDE.md §5.6 测试静默纪律的第 3 级守卫)。
//
// 为什么需要它:窗口可见性策略有 unittest(window-visibility.test.ts)、脚本侧有静态守卫
// (quiet-launch-audit.mjs),但**"用户的焦点到底有没有被抢走"只有真 app 能证明**。
// 这条 e2e 就是那个证据:静默拉起后前台 App 不变、窗口不可聚焦,同时隐藏窗口照样渲染、照样收输入
// (隐藏窗口不能渲染/不能截图,是这套方案唯一的失败模式——所以必须显式验,不能假设)。
//
// 覆盖:
//   A) 拉起前后前台 App 不变(lsappinfo,macOS)——用户实际被抢的就是这个;
//   B) 窗口不可聚焦:window.kernel.window.isFocused() === false(走产品自己的 Host 链路);
//   C) 隐藏窗口照样渲染:DOM 元素齐全 + 截图非黑(自解 PNG 统计字节多样性,零新依赖);
//   D) 隐藏窗口照样吃 CDP 输入:键入落进 composer(Input.dispatchKeyEvent 不经窗口焦点)。
//
// 零 token(不发送任何消息)。用法: npm run build && node scripts/demo/quiet-launch.e2e.mjs [--port 9367] [--keep]
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { waitForDomIdle, sleep } from "./lib/util.mjs";
import { pngStats } from "./lib/png-ink.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "9367" }, keep: { type: "boolean", default: false } } });

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/** 当前前台 App 名(macOS)。没有权限门槛、不触发放置,纯读。 */
function frontApp() {
  if (process.platform !== "darwin") return null;
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf-8" }).trim();
    return execFileSync("lsappinfo", ["info", "-only", "name", asn], { encoding: "utf-8" })
      .split("=")[1]?.replace(/"/g, "").trim() ?? null;
  } catch {
    return null; // 非 macOS 或 lsappinfo 缺失 → 该断言跳过(不伪造)
  }
}

/** 被验应用可能的前台名(未打包的 electron 进程名可能是 Electron)。 */
const APP_NAMES = ["My Harness Desktop", "Electron", "electron"];

// ── 隔离 HOME(一次性,零 token) ──
const runRoot = makeRunRoot();
const home = join(runRoot, "zh-CN");
mkdirSync(home, { recursive: true });
setupBaseline({ home, realHome: homedir(), locale: "zh-CN" });
const projectDir = join(runRoot, "project");
mkdirSync(projectDir, { recursive: true });
// lastCwd 决定首屏有没有 composer(没有打开的项目就只画空态)——不种它,断言会卡在等 composer。
const prefsFile = join(home, ".my-harness-desktop-dev", "config", "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));

const before = frontApp();
console.log(`  前台 App(拉起前): ${before ?? "(非 macOS/不可读)"}`);

// 不显式传 MHD_WINDOW:验的正是"默认就是静默"(quiet-env.mjs 的默认值)。
const app = await launchApp({ appDir: ROOT, port: Number(args.port), env: { HOME: home, MHD_PORT: "18477" }, timeoutMs: 90000 });
const page = app.page;
const consoleTail = [];
page.on("pageerror", (e) => consoleTail.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 900, timeoutMs: 25000 });
  const afterReady = frontApp();

  // ── A) 前台 App 没被抢 ──
  if (before === null) {
    console.log("  ~ 跳过前台 App 断言(非 macOS 或 lsappinfo 不可用)");
  } else {
    ok(!APP_NAMES.includes(afterReady ?? ""), `前台 App 未变成被测应用(现为「${afterReady}」)`);
  }

  // ── B) 窗口不可聚焦(走产品自己的 window.kernel 链路,不是脚本自说自话) ──
  const focused = await page.evaluate(() => window.kernel.window.isFocused());
  ok(focused === false, `window.isFocused() === false(实际 ${focused})`);

  // ── C) 隐藏窗口照样渲染 ──
  const dom = await page.evaluate(() => ({
    composer: !!document.querySelector("[data-timeline-composer]"),
    text: document.body.innerText.replace(/\s+/g, " ").trim().length,
    visibility: document.visibilityState,
  }));
  ok(dom.composer, "隐藏窗口里 composer 已渲染");
  ok(dom.text > 20, `隐藏窗口里有真实文案(${dom.text} 字)`);
  console.log(`  · document.visibilityState = ${dom.visibility}（隐藏窗口的渲染态留证）`);

  const shotPath = join(runRoot, "quiet-window.png");
  // 新版 puppeteer 的 screenshot 返回 Uint8Array(不是 Buffer),显式包一层。
  const buf = Buffer.from(await page.screenshot({ type: "png" }));
  writeFileSync(shotPath, buf);
  const ink = pngStats(buf);
  console.log(`  · 截图 ${ink.width}×${ink.height} ${(buf.length / 1024).toFixed(1)}KB` +
    `,不同颜色 ${ink.colors} 种,非背景像素 ${(ink.nonBgRatio * 100).toFixed(1)}%` +
    `(空帧标尺:颜色 1 种 / 非背景 0%)`);
  ok(ink.colors >= 24 && ink.nonBgRatio > 0.02,
    `隐藏窗口截图有真实内容(颜色 ${ink.colors} 种,非背景 ${(ink.nonBgRatio * 100).toFixed(1)}%)`);

  // ── D) 隐藏窗口照收 CDP 输入 ──
  await page.evaluate(() => document.querySelector("[data-timeline-composer]")?.focus?.());
  await page.keyboard.type("静默测试");
  await sleep(300);
  const typed = await page.evaluate(() => document.querySelector("[data-timeline-composer]")?.value ?? null);
  ok(typed === "静默测试", `CDP 键入落进 composer(实际「${typed}」)`);

  // 清掉草稿,别把字留在隔离 HOME 的会话里(keep 模式下人工查看时干净)
  await page.evaluate(() => {
    const ta = document.querySelector("[data-timeline-composer]");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);

  ok(consoleTail.length === 0, `页面零报错(实际 ${consoleTail.length} 条)`);

  await killApp(app);
  console.log(`\n✅ PASS: ${passed} 项断言(测试静默:不抢焦点 + 隐藏窗口照样渲染/收输入,零 token)`);
  console.log(`   物证截图:${shotPath}`);
  if (!args.keep) {
    // Electron 的 helper 进程退出后还会往 userData 里写一下:直接删会 ENOTEMPTY(实测偶发)。
    // 清理失败不该把一次全绿的验证染成崩溃,所以只告警不抛。
    await sleep(400);
    try {
      rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.warn(`  · 隔离 HOME 清理失败(不影响结论):${err.message}`);
    }
  }
  process.exit(0);
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  if (consoleTail.length) console.error("页面错误:", consoleTail.slice(0, 5).join("\n"));
  console.error(`隔离 HOME 保留在 ${home}(用于现场排查)`);
  await killApp(app).catch(() => {});
  process.exit(1);
}
