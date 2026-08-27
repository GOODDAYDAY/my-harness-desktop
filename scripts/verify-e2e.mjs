#!/usr/bin/env node
// E2E 验证:运行整个服务 → 前端页面元素齐全 → 所有插件 load 成功 → DOM 交互 → 成功发送一个 ping。
//
// 必须在沙箱外跑(要监听 127.0.0.1:8420/9222 + 访问模型网络):
//   node scripts/verify-e2e.mjs            # 构建产物(electron .,renderer 由 8420 静态服务)
//   node scripts/verify-e2e.mjs --dev      # dev 态(electron-vite dev,renderer 由 Vite 服务 + /rpc 反代)
// 产物:/tmp/mhd-verify-<ts>/(report.json + 截图 + electron.log)
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
// --dev:走用户 `npm run dev` 同款链路(electron-vite dev + Vite renderer + /rpc 反代 8420)。
const DEV = process.argv.includes("--dev");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = `/tmp/mhd-verify-${TS}`;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {
  startedAt: new Date().toISOString(), outDir: OUT,
  checks: [], screenshots: [], consoleErrors: [], pageErrors: [],
  plugins: null, ping: null, ok: false,
};
const log = (...a) => console.log(`[verify] ${a.map(String).join(" ")}`);
function check(name, ok, detail = "") {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return !!ok;
}
function saveReport() {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
}
async function shot(page, name) {
  try {
    await page.screenshot({ path: join(OUT, name) });
    report.screenshots.push(name);
  } catch (e) { log("截图失败", name, e.message); }
}

async function httpJson(url, timeoutMs = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, error: e.cause?.code ?? e.message };
  }
}

// ---------- 0. 预检:端口必须空闲(避免误操作用户已开着的实例) ----------
const CDP_PORT = 9222;
const SVC_PORT = 8420;
const cdpAlive = async () => (await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`)).status > 0;
if (await cdpAlive()) {
  check("preflight: CDP 端口空闲", false, `${CDP_PORT} 已有实例在跑`);
  saveReport();
  process.exit(1);
}
const svcStatus0 = await httpJson(`http://127.0.0.1:${SVC_PORT}/status.json`);
if (svcStatus0.status > 0) {
  check("preflight: 8420 端口空闲", false, `8420 已被占用: ${svcStatus0.body?.slice(0, 100)}`);
  saveReport();
  process.exit(1);
}
log(`产物目录: ${OUT}`);

// ---------- 1. 拉起应用(真实 HOME = 真实 dev profile) ----------
// dev 态走 electron-vite dev(用户 `npm run dev` 同款);构建态走 electron .(out/ 产物)。
const electronLogStream = createWriteStream(join(OUT, "electron.log"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = DEV
  ? spawn(process.execPath, [
      join(ROOT, "node_modules/electron-vite/bin/electron-vite.js"),
      "dev", "--", `--remote-debugging-port=${CDP_PORT}`,
    ], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] })
  : spawn(require("electron"), [ROOT, `--remote-debugging-port=${CDP_PORT}`], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
child.stdout?.pipe(electronLogStream);
child.stderr?.pipe(electronLogStream);
let electronExited = null;
child.on("exit", (code, signal) => { electronExited = { code, signal }; log(`electron 退出 code=${code} signal=${signal}`); });

let browser = null;
let page = null;
let teardownDone = false;
async function teardown() {
  if (teardownDone) return;
  teardownDone = true;
  try { browser?.disconnect(); } catch { /* ignore */ }
  if (child.exitCode === null && electronExited === null) {
    child.kill("SIGINT");
    const deadline = Date.now() + 8000;
    while (child.exitCode === null && Date.now() < deadline) await sleep(150);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  // dev 态兜底:electron-vite 把 electron 起成孙进程,父进程退了孙进程可能仍占着
  // 8420/9222——按端口收尸,保证下一轮预检端口空闲。
  await sleep(500);
  for (const port of [SVC_PORT, CDP_PORT]) {
    try { execSync(`lsof -ti tcp:${port} | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch { /* 无残留 */ }
  }
}

try {
  // dev 态首轮要过 Vite 依赖预构建 + 按需编译,给足 90s;构建态 45s 够用。
  const deadline = Date.now() + (DEV ? 90000 : 45000);
  while (!(await cdpAlive())) {
    if (electronExited) throw new Error(`electron 启动即退出: ${JSON.stringify(electronExited)}(见 electron.log)`);
    if (Date.now() > deadline) throw new Error("等待 CDP 端口超时");
    await sleep(300);
  }
  check("服务: electron 拉起 + CDP 就绪", true, `port ${CDP_PORT}`);

  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });
  // 主窗口 URL 形态:构建态 = http://127.0.0.1:8420/?lt=…;dev 态 = Vite dev server
  // (http://localhost:<port>/?lt=…,electron-vite 注入的 ELECTRON_RENDERER_URL)。
  // 匹配:后端端口页 / Vite localhost 页 / 含 index.html 的页。独立 30s 截止,不复用 CDP 的 45s。
  const isAppPage = (u) =>
    u.includes(`127.0.0.1:${SVC_PORT}`) || u.includes("renderer/index.html") ||
    u.includes("index.html") || /^http:\/\/localhost:\d+/.test(u);
  const pageDeadline = Date.now() + 30000;
  while (!page) {
    for (const p of await browser.pages()) {
      const u = p.url();
      if (isAppPage(u)) { page = p; break; }
    }
    if (!page) {
      if (Date.now() > pageDeadline) {
        const urls = (await browser.pages()).map((p) => p.url()).join(" | ");
        throw new Error(`等待 renderer 页超时(当前 pages: ${urls || "无"})`);
      }
      await sleep(300);
    }
  }
  page.setDefaultTimeout(30000);
  page.on("console", (msg) => {
    if (msg.type() === "error") report.consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on("pageerror", (err) => report.pageErrors.push(String(err).slice(0, 500)));

  // ---------- 2. 等 window.kernel(WS 连通 = 前后端链路通) ----------
  await page.waitForFunction(() => !!window.kernel?.plugins?.list, { timeout: DEV ? 60000 : 30000 });
  check("服务: window.kernel 就绪(WS /rpc 连通)", true);

  const svcStatus = await httpJson(`http://127.0.0.1:${SVC_PORT}/status.json`);
  check("服务: HTTP /status.json", svcStatus.status === 200, svcStatus.body ?? svcStatus.error);

  // ---------- 3. 等插件加载 + 页面元素 ----------
  // 插件 renderer 异步加载;等 DOM 骨架 + 给插件 5s 宽限,再统一验收。
  await page.waitForSelector("[data-sidebar-style]", { timeout: 30000 });
  await page.waitForSelector("[data-timeline-composer], [class*='h-10']", { timeout: 30000 });
  await sleep(5000);
  await shot(page, "01-ui-ready.png");

  const elements = await page.evaluate(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { exists: false, visible: false };
      const vis = el.checkVisibility?.({ checkVisibilityCSS: true, checkOpacity: false }) ?? true;
      const r = el.getBoundingClientRect();
      return { exists: true, visible: vis && r.width > 0 && r.height > 0 };
    };
    return {
      root: q("#root"),
      rootChildCount: document.getElementById("root")?.childElementCount ?? 0,
      sidebar: q("[data-sidebar-style]"),
      sidepanel: q("[data-sidepanel-style]"),
      composer: q("[data-timeline-composer]"),
      composerTextarea: q("textarea[data-timeline-composer]"),
      titlebar: q("div[class*='h-10'][class*='select-none']"),
      sessionNodes: document.querySelectorAll("[data-session-path]").length,
      messageNodes: document.querySelectorAll("[data-message-id]").length,
      bodyTextLen: document.body.innerText.trim().length,
      lang: document.documentElement.lang,
    };
  });
  report.elements = elements;
  check("页面: #root 已渲染", elements.root.exists && elements.rootChildCount > 0, `children=${elements.rootChildCount}`);
  check("页面: 标题栏", elements.titlebar.exists, elements.titlebar.visible ? "可见" : "存在但不可见");
  check("页面: 左栏 sidebar", elements.sidebar.exists && elements.sidebar.visible);
  check("页面: 右栏 sidepanel", elements.sidepanel.exists && elements.sidepanel.visible);
  check("页面: 输入框 composer+textarea", elements.composer.exists && elements.composerTextarea.exists,
    elements.composerTextarea.visible ? "可见" : "存在但不可见");
  check("页面: 非黑屏", elements.bodyTextLen > 20, `bodyText ${elements.bodyTextLen} 字符, lang=${elements.lang}`);

  // ---------- 4. 插件全量加载 ----------
  const pluginInfo = await page.evaluate(async () => {
    const list = await window.kernel.plugins.list();
    const byState = {};
    for (const p of list) byState[p.state] = (byState[p.state] ?? 0) + 1;
    const notActive = list.filter((p) => p.state !== "active").map((p) => `${p.id}(${p.source},${p.state})`);
    const builtin = list.filter((p) => p.source === "builtin");
    const ids = new Set(list.map((p) => p.id));
    const keyIds = ["timeline", "sessions-list", "plugin-manager", "theme", "projects", "session-tree", "file-tree", "git-review", "markdown", "keybindings", "i18n"];
    return {
      total: list.length, byState, notActive,
      builtinTotal: builtin.length,
      builtinNotActive: builtin.filter((p) => p.state !== "active").map((p) => `${p.id}(${p.state})`),
      keyIdsMissing: keyIds.filter((k) => !ids.has(k)),
      ids: list.map((p) => p.id).sort(),
    };
  });
  report.plugins = pluginInfo;
  const hostErrors = report.consoleErrors.filter((t) => t.includes("plugins-host") || t.includes("插件加载失败"));
  check("插件: 内置插件全部在册", pluginInfo.builtinTotal >= 49, `builtin=${pluginInfo.builtinTotal} total=${pluginInfo.total}`);
  check("插件: 全部 state=active", pluginInfo.notActive.length === 0,
    pluginInfo.notActive.length ? pluginInfo.notActive.join(", ") : `byState=${JSON.stringify(pluginInfo.byState)}`);
  check("插件: renderer 无加载失败上报", hostErrors.length === 0, hostErrors.slice(0, 3).join(" | "));
  check("插件: 关键插件在册", pluginInfo.keyIdsMissing.length === 0,
    pluginInfo.keyIdsMissing.length ? `缺失: ${pluginInfo.keyIdsMissing.join(", ")}` : "timeline/sessions-list/plugin-manager 等均在");

  // ---------- 5. DOM 交互 ----------
  // 5a. 键盘交互:⌘B 收起/展开左栏(shell 内建快捷键)
  const sidebarBefore = await page.evaluate(() => document.querySelector("[data-sidebar-style]")?.getBoundingClientRect().width);
  await page.keyboard.down("Meta"); await page.keyboard.press("KeyB"); await page.keyboard.up("Meta");
  await sleep(600);
  const sidebarAfter = await page.evaluate(() => document.querySelector("[data-sidebar-style]")?.getBoundingClientRect().width ?? 0);
  await page.keyboard.down("Meta"); await page.keyboard.press("KeyB"); await page.keyboard.up("Meta");
  await sleep(600);
  check("交互: ⌘B 切换左栏", Math.abs(sidebarBefore - sidebarAfter) > 1 || sidebarAfter === 0,
    `width ${sidebarBefore} → ${sidebarAfter}`);

  // 5b. 点击右栏页签图标(切走再切回)
  const tabClick = await page.evaluate(() => {
    const strip = document.querySelector("[data-sidepanel-style]");
    const btns = [...(strip?.querySelectorAll("button") ?? [])];
    const target = btns.find((b) => b.checkVisibility());
    if (!target) return { ok: false, why: "侧栏无可见 button" };
    target.click();
    return { ok: true, label: target.getAttribute("aria-label") ?? target.title ?? target.textContent?.trim().slice(0, 20) };
  });
  await sleep(500);
  check("交互: 点击右栏页签", tabClick.ok, tabClick.label ?? tabClick.why);
  await shot(page, "02-after-interact.png");

  // ---------- 6. 发送 ping ----------
  // 事件监听先行(不竞态):记录 session 事件流,判据 = user 消息出去 + 模型回复/轮结束。
  await page.evaluate(() => {
    window.__pingWatch = { events: [], start: Date.now() };
    window.__pingWatch.off = window.kernel.sessions.onEvent((e) => {
      window.__pingWatch.events.push({ dt: Date.now() - window.__pingWatch.start, type: e.type, role: e.message?.role });
    });
  });

  const fallbackModel = await page.evaluate(() => window.kernel.models.getFallbackModel()).catch(() => null);
  log("兜底模型:", JSON.stringify(fallbackModel));

  let composerEl = await page.$("textarea[data-timeline-composer]");
  if (!composerEl) {
    // 无项目打开时 composer 是只读条——点侧栏「项目」里第一个最近目录兜底
    log("composer 不可输入,尝试从侧栏打开最近项目…");
    const opened = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-sidebar-style] div[title^='/']")];
      const target = rows.find((r) => r.checkVisibility?.());
      if (!target) return null;
      const dir = target.getAttribute("title");
      target.click();
      return dir;
    });
    if (!opened) throw new Error("composer 只读且侧栏无最近项目,无法发送 ping");
    log("已点击项目:", opened);
    await page.waitForSelector("textarea[data-timeline-composer]", { timeout: 15000 });
    await sleep(800);
    composerEl = await page.$("textarea[data-timeline-composer]");
  }
  if (!composerEl) throw new Error("composer textarea 不存在,无法发送 ping");
  await composerEl.click();
  await sleep(200);
  await page.keyboard.type("ping", { delay: 30 });
  await shot(page, "03-ping-typed.png");
  await page.keyboard.press("Enter");
  log("ping 已发送,等待模型往返…");

  // 等 user 消息落屏
  await page.waitForFunction(() => [...document.querySelectorAll("[data-message-id]")].some((el) => el.textContent.includes("ping")), { timeout: 15000 });
  check("ping: user 消息落屏", true);
  await shot(page, "04-ping-sent.png");

  // 等轮结束:agentSettled/agentEnd,或 assistant messageEnd。冷启动内核 + 模型往返,给足 5 分钟。
  const roundDone = await page.waitForFunction(() => {
    const evs = window.__pingWatch?.events ?? [];
    return evs.some((e) => ["agentSettled", "agentEnd"].includes(e.type)) || evs.filter((e) => e.type === "messageEnd" && e.role === "assistant").length > 0;
  }, { timeout: 300000 }).then(() => true).catch(() => false);

  const watch = await page.evaluate(() => ({ events: window.__pingWatch?.events ?? [] }));
  const assistantEnd = watch.events.find((e) => e.type === "messageEnd" && e.role === "assistant");
  const lastAssistantText = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[data-message-id]")];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const t = nodes[i].textContent?.trim();
      if (t && !t.startsWith("ping")) return t.slice(0, 300);
    }
    return "";
  });
  report.ping = { roundDone, events: watch.events, assistantEnd: !!assistantEnd, lastAssistantText };
  check("ping: 内核受理并完成一轮", roundDone, roundDone ? `events=${watch.events.length}` : "300s 超时未见轮结束");
  check("ping: 收到 assistant 回复", !!assistantEnd && !!lastAssistantText, lastAssistantText ? `回复: ${lastAssistantText.slice(0, 120)}…` : "无 assistant 文本");
  await shot(page, "05-ping-done.png");

  report.ok = report.checks.every((c) => c.ok);
} catch (err) {
  log("致命错误:", err.message);
  report.fatal = String(err.stack ?? err.message ?? err);
  if (page) await shot(page, "99-fatal.png");
  report.ok = false;
} finally {
  report.consoleErrors = report.consoleErrors.slice(0, 30);
  await teardown();
  saveReport();
}

log(`\n===== 结果: ${report.ok ? "ALL PASS ✅" : "存在失败项 ❌"} =====`);
for (const c of report.checks) if (!c.ok) log(`  FAIL ${c.name} — ${c.detail}`);
log(`报告: ${OUT}/report.json`);
process.exit(report.ok ? 0 : 1);
