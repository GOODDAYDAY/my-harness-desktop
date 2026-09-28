#!/usr/bin/env node
// 插件安装失败必须**可见**且**不卡死** e2e（r95 起，**当前为半成品**）。
//
// r95 首版是半成品（卡在"提交按钮识别不出来"：折叠开关与提交钮文本高度相似，按文本匹配反复点错）。
// r96 按 r95 留下的接手点①处置：**给产品补锚点**而不是让脚本继续猜——
// `data-plugin-install="toggle|source|browse|submit"`（提交钮另带 `data-installing`，
// 让"卡在 installing 态"这个 r80 的根因可以被**直接断言**，而不是靠推断按钮文案）。
// 补锚点同时服务可访问性：折叠开关加了 `aria-expanded`（此前它是个没有展开态语义的按钮）。
//
// ## 被验的缺陷（r80 查明）
//
// 服务端 → renderer 的失败有两种形态：① 返回 `{ok:false,error}`；② handler **抛错**
// ⇒ gateway 转 `{ok:false,error:{code:"HANDLER_ERROR",message}}`（routing/gateway.ts:61-66）
// ⇒ transport **reject**（ws-transport.ts:102）⇒ `await` **throw**。
// plugin-manager 的 5 个 handler 此前只处理①，于是形态②的后果是：
//   · `showFeedback` 走不到 ⇒ **一点提示都没有**（§7.6 禁止的静默失败）；
//   · install 那条还让 `setInstalling(false)` / `setInstallOpen(false)` / `setInstallUrl("")`
//     全走不到 ⇒ **按钮永久停在 installing 态、对话框不关、输入不清**，用户只能刷新页面。
// r80 的修法：抽 `runOp` 收敛两种形态 + install 用 `try/finally` 保证解除 busy 态。
// 本剧本就是那条修复的**直接**真机证据（此前只有 r87 的链路间接证据 + r90 的 DOM 层证据）。
//
// ## 手段与载体
//
// 载体是 installer 的一条**确定性抛错**：安装源是 `.zip` 时
// `src/server/application/installer/index.ts` 明确 `throw`（r91 已把它本地化成
// `shell.installZipUnsupported`）。所以只需在隔离 HOME 里造一个假 `.zip` 文件、
// 把它的路径填进安装框、点安装——不需要网络、不需要 npm、零 token。
//
// ⚠ 导航要用 r93 补的锚点（`data-settings-pane` / `-active`）判"哪个条目激活了"，
//   不要用 `[role=tabpanel]`（无 `tabs` 的条目不渲染它）也不要用可见性（r92：两个视图可能同时在渲染树里）。
//
// 零 token：不进会话、不发消息、不联网。
//
// 用法: npm run build && node scripts/demo/plugin-install-failure.e2e.mjs [--locale zh-CN|en] [--port 9870] [--keep]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchApp, killApp } from "./lib/app.mjs";
import { makeRunRoot, setupBaseline } from "./lib/home.mjs";
import { seedTestPlugins } from "./lib/test-plugins.mjs";
import { waitForDomIdle } from "./lib/util.mjs";
import { clickPointUntil } from "./lib/interact.mjs";

const { values: args } = parseArgs({ options: {
  locale: { type: "string", default: "zh-CN" }, port: { type: "string", default: "9870" }, keep: { type: "boolean", default: false } } });
const LOCALE = args.locale;
/** 各语言预期文案（取自 system/i18n 的 shell.json；这里只取可辨识片段，避免在剧本里另抄整句）。 */
const EXPECT = { "zh-CN": "ZIP", "zh-TW": "ZIP", en: "ZIP", de: "ZIP" };

let passed = 0;
function ok(cond, label, detail) {
  if (!cond) throw new Error(`断言失败: ${label}${detail !== undefined ? `（现场：${JSON.stringify(detail)?.slice(0, 300)}）` : ""}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const runRoot = makeRunRoot();
const home = join(runRoot, LOCALE);
mkdirSync(home, { recursive: true });
const ctx = setupBaseline({ home, realHome: homedir(), locale: LOCALE });
seedTestPlugins(ctx.dataRoot);
const projectDir = join(home, "project");
mkdirSync(projectDir, { recursive: true });
const prefsFile = join(ctx.configDir, "config.json");
writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, "utf-8")), lastCwd: projectDir }, null, 2));
// 造一个假的 .zip（内容无关：installer 在读内容之前就先按扩展名/魔数拒绝）
const zipPath = join(home, "fake-plugin.zip");
writeFileSync(zipPath, "PK\u0003\u0004 not a real plugin archive", "utf-8");

const app = await launchApp({
  appDir: join(import.meta.dirname, "..", ".."),
  port: Number(args.port),
  env: { HOME: home, MHD_PORT: "18401" },
  timeoutMs: 90000,
});
const page = app.page;
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

try {
  await page.waitForSelector("[data-timeline-composer]", { timeout: 30000 });
  await waitForDomIdle(page, { quietMs: 1000, timeoutMs: 25000 });

  console.log(`\n── 导航到设置页 → 插件管理（用 r93 的 pane 锚点判激活）──`);
  await page.evaluate(() => document.querySelector('[data-sidebar-entry="settings"]')?.click());
  await waitForDomIdle(page, { quietMs: 700, timeoutMs: 15000 }).catch(() => {});
  const point = (sel) => (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(12, r.height / 2)) } : null;
  };
  await clickPointUntil(page, point(), (s) => {
    const p = document.querySelector('[data-settings-pane="plugins"]');
    return !!p && p.getAttribute("data-settings-pane-active") === "true";
  }, { tries: 6, settleMs: 450, arg: '[data-settings-id="plugins"]' }).catch(() => {});
  const active = await page.evaluate(() => document.querySelector('[data-settings-pane="plugins"]')?.getAttribute("data-settings-pane-active"));
  ok(active === "true", "插件管理面板已激活（data-settings-pane-active=true）", { active });

  console.log(`\n── 填入 .zip 安装源并点安装 ──`);
  // 安装框：占位符含 URL/本地文件（plugin-manager 的安装入口）
  const dump = await page.evaluate(() => {
    const pane = document.querySelector('[data-settings-pane="plugins"]');
    if (!pane) return "(无 pane)";
    return JSON.stringify({
      inputs: [...pane.querySelectorAll("input")].map((i) => i.type + "|" + (i.placeholder || "")).slice(0, 8),
      buttons: [...pane.querySelectorAll("button")].map((b) => (b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 14)).slice(0, 14),
    });
  });
  console.log("  · pane 内控件:", dump.slice(0, 460));
  // ⚠ 安装表单**默认折叠**：要先点 data-plugin-install="toggle" 展开（r96 补的锚点）。
  //   r95 按文本匹配反复命中错的按钮（折叠开关与提交钮文本高度相似），故改为按锚点。
  await clickPointUntil(page, () => {
    const el = document.querySelector('[data-plugin-install="toggle"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
  }, () => !!document.querySelector('[data-plugin-install="source"]'), { tries: 4, settleMs: 400 }).catch(() => {});

  const typed = await page.evaluate((zp) => {
    const pane = document.querySelector('[data-settings-pane="plugins"]');
    const input = document.querySelector('[data-plugin-install="source"]');
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, zp);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.placeholder;
  }, zipPath);
  ok(!!typed, "找到安装源输入框并填入了 .zip 路径", { typed });

  const btn = await page.evaluate(() => {
    const el = document.querySelector('[data-plugin-install="submit"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), disabled: el.disabled };
  });
  ok(!!btn && btn.w > 0 && !btn.disabled, `提交钮可点（${JSON.stringify(btn)}）`);
  if (btn) await page.mouse.click(btn.x, btn.y);
  await new Promise((r) => setTimeout(r, 2500));

  const out = await page.evaluate(() => {
    const body = document.body.innerText || "";
    const el = document.querySelector('[data-plugin-install="submit"]');
    return {
      body,
      // r96：提交钮带 data-installing 锚点，可直接断言"有没有卡在 installing 态"
      installing: el ? el.getAttribute("data-installing") : "(钮已不在 DOM)",
      disabled: el ? el.disabled : null,
      formStillOpen: !!document.querySelector('[data-plugin-install="source"]'),
      sourceValue: document.querySelector('[data-plugin-install="source"]')?.value ?? null,
    };
  });
  const all = out.body;
  console.log(`\n── 断言：失败可见 + 不卡死（r80 的修复）──`);
  ok(all.includes(EXPECT[LOCALE] ?? "ZIP"), `界面出现 ZIP 不支持的**本语言**提示（r91 已把这条服务端消息本地化）`, all.slice(0, 200));
  ok(/tar\.gz/.test(all), "提示里给出了**可执行的下一步**（改用 .tar.gz），不是只说『失败了』");
  ok(!/shell\.installZipUnsupported/.test(all), "显示的是译文而不是裸 i18n 键");
  ok(out.installing === "false", `提交钮**没有卡在 installing 态**（data-installing=${out.installing}、disabled=${out.disabled}）——这正是 r80 修的根因`);
  ok(out.formStillOpen === true, "失败后表单**保持打开**（r80 的设计：成功才关，失败留着方便改完重试）");
  ok(out.sourceValue && out.sourceValue.endsWith(".zip"), `失败后输入**没被清空**（当前值=${JSON.stringify(out.sourceValue)?.slice(0, 60)}）`);
  ok(pageErrors.length === 0, `页面零报错（实际 ${pageErrors.length} 条${pageErrors.length ? ": " + pageErrors.slice(0, 2).join(" | ").slice(0, 160) : ""}）`);

  // ── ⚠ 本剧本目前只覆盖到"表单已展开、安装源已填入"这一步（r95）──────────────
  // 未覆盖：**提交之后**的失败反馈与"不卡死"（也就是 r80 修复的核心）。
  // 卡点是提交按钮识别：面板顶部有一个「安装插件」**折叠开关**，文本与表单内的提交钮
  // 高度相似，按文本/容器匹配反复命中它（点它等于把刚展开的表单又关上）；
  // 在输入框里按 Enter 也不提交。
  // 下一轮的接手点（按优先级）：
  //   ① 给安装表单的提交钮补一个稳定锚点（如 data-plugin-install="submit"）——
  //      这与 r89/r93 的处置一致：产品缺锚点时，补锚点比让脚本猜更根本（§10.3）；
  //   ② 或读 plugin-manager 的 JSX 找出提交钮的真实文本/结构，按结构而非文本定位；
  //   ③ 补完后把下面这段断言恢复（git 历史里有：ZIP 提示可见 / 含 tar.gz 指引 /
  //      非裸键 / 按钮不卡在 installing 态 / 页面零报错）。
} catch (err) {
  console.error(`\n❌ FAIL: ${err.message}`);
  await page.screenshot({ path: join(runRoot, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await killApp(app);
}

console.log(`\n✅ PASS: ${passed} 项断言（安装失败可见且不卡死，locale=${LOCALE}）`);
console.log(`   隔离 HOME: ${home}${args.keep ? "（--keep 保留）" : ""}`);
