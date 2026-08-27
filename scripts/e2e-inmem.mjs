#!/usr/bin/env node
// 沙箱内 E2E(无网络版):真实 assemble + 真实 renderer 构建产物,传输用内存桥(同 wire 协议)。
// 沙箱禁 bind/connect(含 loopback),故 TCP/WS 层用等价内存桥替代;其余全真:
// 真实插件注册表/网关/会话存储/内核子进程、真实 renderer bundle(jsdom 内渲染)、真实 DOM 交互。
// 模型 API 网络在沙箱内不可达——ping 以「内核受理 + user 消息落盘」为成功判据,模型回复尽力而为。
//
// 用法:node scripts/e2e-inmem.mjs [--stage server|all]
// 产物:/tmp/mhd-inmem-<ts>/report.json
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, symlinkSync, existsSync, statSync, lstatSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import net from "node:net";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STAGE = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "all";
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = `/tmp/mhd-inmem-${TS}`;
const E2E_HOME = join(ROOT, ".e2e-home");
const REAL_HOME = process.env.HOME; // 覆盖前记住真实 HOME(取种子配置用)
const PROJECT_DIR = join(E2E_HOME, "project");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { mode: "in-memory", startedAt: new Date().toISOString(), outDir: OUT, checks: [], consoleErrors: [], consoleWarns: [], ok: false };
const log = (...a) => console.log(`[inmem] ${a.map(String).join(" ")}`);
function check(name, ok, detail = "") {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return !!ok;
}
function saveReport() {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
}

// ---------- 0. 隔离 HOME 播种(真实配置做种子,数据根落工作区可写) ----------
function seedHome() {
  if (existsSync(E2E_HOME)) rmSync(E2E_HOME, { recursive: true, force: true });
  const DATA = join(E2E_HOME, ".my-harness-desktop-dev");
  mkdirSync(join(E2E_HOME, ".pi", "agent"), { recursive: true });
  mkdirSync(join(E2E_HOME, ".dsh"), { recursive: true });
  mkdirSync(join(DATA, "pi"), { recursive: true });
  mkdirSync(join(DATA, "dsh"), { recursive: true });
  mkdirSync(join(DATA, "config"), { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(join(PROJECT_DIR, "README.md"), "# e2e in-memory sandbox project\n");
  // pi 内核配置种子(模型清单 + 路由)
  for (const f of ["models.json", "model-routing.json"]) {
    const src = join(REAL_HOME, ".pi", "agent", f);
    if (existsSync(src)) cpSync(src, join(E2E_HOME, ".pi", "agent", f));
  }
  // dsh 配置种子(cordis 组合 + settings/默认模型)
  for (const f of ["cordis.yml", "settings.yaml"]) {
    const src = join(REAL_HOME, ".dsh", f);
    if (existsSync(src)) cpSync(src, join(E2E_HOME, ".dsh", f));
  }
  // 真实 profile 的 ~/.dsh/node_modules 是软链到 dsh 暂存的 node_modules——
  // .my-harness-desktop-plugins/ 下的适配插件经此解析 @deepseek-ai/* 依赖
  // (须在 DATA/dsh/node_modules 链接建好后,故放到内核暂存播种之后)。
  // 内核暂存:package.json 拷贝 + node_modules 符号链接借真实安装(只读执行)
  for (const k of ["pi", "dsh"]) {
    const real = join(REAL_HOME, ".my-harness-desktop-dev", k);
    const stage = join(DATA, k);
    for (const f of ["package.json", "package-lock.json"]) {
      if (existsSync(join(real, f))) cpSync(join(real, f), join(stage, f));
    }
    if (existsSync(join(real, "node_modules"))) symlinkSync(join(real, "node_modules"), join(stage, "node_modules"));
  }
  symlinkSync(join(DATA, "dsh", "node_modules"), join(E2E_HOME, ".dsh", "node_modules"));
  // 播种后立即自检
  for (const k of ["pi", "dsh"]) {
    const stage = join(DATA, k);
    let entries = [];
    try { entries = readdirSync(stage); } catch {}
    const hasNm = entries.includes("node_modules");
    const nmReal = hasNm ? (() => { try { return lstatSync(join(stage, "node_modules")).isSymbolicLink(); } catch { return false; } })() : false;
    log(`播种自检: ${k}/ = [${entries.join(", ")}] node_modules符号链接=${nmReal}`);
  }
  // 偏好:打开项目 = 隔离项目目录
  writeFileSync(join(DATA, "config", "config.json"), JSON.stringify({ lastCwd: PROJECT_DIR, currentLocale: "zh-CN" }, null, 2));
  // general.json 用真实 profile 的(含布局树);缺则最小种子
  const realGeneral = join(REAL_HOME, ".my-harness-desktop-dev", "config", "general.json");
  if (existsSync(realGeneral)) cpSync(realGeneral, join(DATA, "config", "general.json"));
  else writeFileSync(join(DATA, "config", "general.json"), JSON.stringify({ defaultThinkingLevel: "high", sidebarDefaultOpen: true }, null, 2));
  writeFileSync(join(DATA, "config", "projects.json"), JSON.stringify({ recentCwds: [PROJECT_DIR] }, null, 2));
  log(`隔离 HOME: ${E2E_HOME}(project=${PROJECT_DIR})`);
}

// ---------- 1. 网络补丁:listen 空转(沙箱禁 bind;传输走内存桥) ----------
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
  process.nextTick(() => {
    this.emit("listening");
    if (cb) cb();
  });
  return this;
};
log("net.Server.listen 已替换为内存空转(沙箱无 bind 权限)");

// ---------- 2. 起真实服务 ----------
seedHome();
process.env.HOME = E2E_HOME; // 数据根/~/.pi/~/.dsh 全部落隔离区

const chunkFile = readdirSync(join(ROOT, "out", "main", "chunks")).find((f) => f.startsWith("assemble-") && f.endsWith(".js"));
if (!chunkFile) { console.error("未找到 out/main/chunks/assemble-*.js,先 npm run build"); process.exit(1); }
const { assemble } = require(join(ROOT, "out", "main", "chunks", chunkFile));

const unsupported = (name) => () => Promise.reject(new Error(`${name}: UNSUPPORTED_HOST`));
const nodeHost = {
  lifecycle: {
    onReady(cb) { cb(); },
    onBeforeQuit() {},
    quit() { log("host.quit 调用(拦截,不退出)"); },
  },
  window: {
    minimize: unsupported("window.minimize"), toggleMaximize: unsupported("window.toggleMaximize"),
    close: unsupported("window.close"), isMaximized: async () => false, isFocused: async () => true,
    onMaximizedChanged: () => () => {},
  },
  dialog: {
    openDirectory: unsupported("dialog.openDirectory"), openImages: async () => [],
    openTextFile: unsupported("dialog.openTextFile"), saveTextFile: unsupported("dialog.saveTextFile"),
    writeImages: unsupported("dialog.writeImages"), saveZip: unsupported("dialog.saveZip"), openZip: unsupported("dialog.openZip"),
  },
  shell: { openPath: unsupported("shell.openPath"), openExternal: unsupported("shell.openExternal"), revealPath: unsupported("shell.revealPath") },
  notify: { async show() {} },
  app: {
    async info() { return { name: "my-harness-desktop", version: "0.5.0-beta", electron: null, node: process.versions.node, chrome: null, platform: process.platform, isPackaged: false }; },
    restart: unsupported("app.restart"),
  },
  theme: { shouldUseDarkColors: () => false, onThemeChanged: () => () => {} },
  platform: process.platform,
};

let assembled;
try {
  process.chdir(ROOT); // builtin 插件目录/静态目录/DSH 适配插件源都相对 cwd
  assembled = assemble(nodeHost, { isPackaged: false });
} catch (err) {
  check("服务: assemble 组装", false, String(err.message ?? err));
  saveReport();
  process.exit(1);
}
const { ctx, sessionStore, gateway, localToken } = assembled;
check("服务: assemble 组装(真实服务全量)", true, `channels=${gateway.channelCount()}`);
await sleep(1500); // 等启动期异步同步(skills 镜像/插件扩展同步)落定

// ---------- 3. 内存桥:等价 ws-server 连接逻辑(同 wire 协议) ----------
let connSeq = 0;
const invokeStats = { started: [], latency: [] };
function bridgeAttach(ws) {
  const conn = { id: `conn-inmem-${++connSeq}`, kind: "remote", host: nodeHost, authenticated: false };
  // 本地窗口自动鉴权(等价 ws-server 的 cookie 免 hello 路径):内存桥即本地窗口,
  // 直接用 localToken 验过,避免 renderer 早期 invoke 与 hello 帧的竞态(真机由网络时延天然错开)。
  gateway.authenticate(conn, localToken);
  const offSink = gateway.addSink((msg) => { if (ws.readyState === 1) ws._receive(JSON.stringify(msg)); });
  ws._serverMessage = (text) => {
    let m;
    try { m = JSON.parse(text); if (!m || typeof m !== "object" || typeof m.kind !== "string") return; } catch { return; }
    if (m.kind === "hello" && "token" in m) {
      const ok = gateway.authenticate(conn, m.token);
      ws._receive(JSON.stringify({ kind: "hello", ok }));
      if (!ok) ws.close();
      return;
    }
    if (m.kind === "invoke") {
      const t0 = Date.now();
      invokeStats.started.push({ id: m.id, channel: m.channel, t: t0 });
      void gateway.dispatch(conn, m).then((res) => {
        invokeStats.latency.push({ id: m.id, channel: m.channel, ms: Date.now() - t0, ok: res.ok, err: res.ok ? "" : String(res.error?.message ?? "").slice(0, 80) });
        if (ws.readyState === 1) ws._receive(JSON.stringify(res));
      });
    }
  };
  ws._serverClose = () => offSink();
}

// ---------- 4. 服务端探针:不经 renderer 直接验注册表/模型面 ----------
function makeProbeConn() {
  const conn = { id: `conn-probe-${++connSeq}`, kind: "remote", host: nodeHost, authenticated: false };
  const ok = gateway.authenticate(conn, localToken);
  if (!ok) throw new Error("localToken 鉴权失败");
  let seq = 0;
  return {
    async invoke(channel, ...args) {
      const res = await gateway.dispatch(conn, { kind: "invoke", id: ++seq, channel, args });
      if (!res.ok) throw new Error(`${channel}: ${res.error?.message}`);
      return res.result;
    },
  };
}
const probe = makeProbeConn();

async function probeChannels() {
  // 探测真实 channel 字面值:逐一尝试候选
  const candidates = {
    pluginsList: ["plugins:list", "plugins.list", "plugin:list"],
    modelsList: ["models:list", "models.list"],
    fallback: ["models:getFallbackModel", "models.getFallbackModel"],
    appInfo: ["app:info", "app.info", "appInfo"],
  };
  const found = {};
  for (const [key, list] of Object.entries(candidates)) {
    for (const ch of list) {
      try {
        const res = await gateway.dispatch({ id: "probe", kind: "local", host: nodeHost, authenticated: true }, { kind: "invoke", id: 1, channel: ch, args: [] });
        if (res.ok || res.error?.code !== "UNKNOWN_CHANNEL") { found[key] = ch; break; }
      } catch { /* next */ }
    }
  }
  return found;
}
const channels = await probeChannels();
log("channel 探测:", JSON.stringify(channels));
report.channels = channels;

let pluginListFromServer = null;
if (channels.pluginsList) {
  try {
    pluginListFromServer = await probe.invoke(channels.pluginsList);
    const byState = {};
    for (const p of pluginListFromServer) byState[p.state] = (byState[p.state] ?? 0) + 1;
    const builtin = pluginListFromServer.filter((p) => p.source === "builtin");
    report.serverPlugins = { total: pluginListFromServer.length, byState, builtin: builtin.length, ids: pluginListFromServer.map((p) => p.id).sort() };
    check("服务: 插件注册表(内置 49 全在册)", builtin.length >= 49, `builtin=${builtin.length} total=${pluginListFromServer.length} byState=${JSON.stringify(byState)}`);
    const notActive = pluginListFromServer.filter((p) => p.state !== "active");
    check("服务: 插件全部 state=active", notActive.length === 0, notActive.length ? notActive.map((p) => `${p.id}(${p.state})`).join(", ") : JSON.stringify(byState));
  } catch (e) {
    check("服务: 插件注册表", false, e.message);
  }
} else {
  check("服务: 插件注册表", false, "plugins channel 未探测到");
}

if (channels.fallback) {
  try {
    const fb = await probe.invoke(channels.fallback);
    report.fallbackModel = fb;
    log("兜底模型:", JSON.stringify(fb));
  } catch (e) { log("兜底模型探测失败:", e.message); }
}

if (STAGE === "server") {
  report.ok = report.checks.every((c) => c.ok);
  saveReport();
  log(`stage=server 完成: ${report.ok ? "PASS" : "FAIL"} → ${OUT}/report.json`);
  process.exit(report.ok ? 0 : 1);
}

// ---------- 5. renderer:jsdom + 真实 bundle + window.kernel(内存 WS) ----------
const { JSDOM } = require("/Users/anker/self/git-project/pi-app/node_modules/jsdom");
const dom = new JSDOM(readFileSync(join(ROOT, "out", "renderer", "index.html"), "utf-8"), {
  url: `http://127.0.0.1:8420/?lt=${encodeURIComponent(localToken)}`,
  pretendToBeVisual: true,
  contentType: "text/html",
});
const { window } = dom;

// 浏览器 API 补丁(jsdom 缺口)
window.matchMedia = window.matchMedia ?? ((q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
// 截图需要:RO 观察即报尺寸(视口容器报 1280x840,消息条目按内容粗估),
// 让 virtuoso 等测量型组件在 jsdom 里产出真实可布局的 DOM。
class RO {
  constructor(cb) { this.cb = cb; }
  observe(el) {
    if ((globalThis.__roLog ??= []).length < 30) globalThis.__roLog.push(`${el?.tagName}.${String(el?.className).slice(0, 30)}[${el?.getAttribute?.("data-testid") ?? el?.getAttribute?.("data-virtuoso-scroller") ?? ""}]`);
    const b = boxFor(el) ?? { w: 860, h: 640 };
    const h = b.h, w = b.w;
    setTimeout(() => this.cb?.([{ target: el, contentRect: { width: w, height: h, top: 0, left: 0, bottom: h, right: w, x: 0, y: 0 }, borderBoxSize: [{ inlineSize: w, blockSize: h }], contentBoxSize: [{ inlineSize: w, blockSize: h }] }]), 0);
  }
  unobserve() {} disconnect() {}
}
window.ResizeObserver = RO;
window.IntersectionObserver = window.IntersectionObserver ?? class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
if (!window.Element.prototype.checkVisibility) window.Element.prototype.checkVisibility = function () { return true; };
// jsdom 的 CSSStyleDeclaration 不可迭代;真实 Chromium 可 [...el.style](ThemeProvider 用到)
if (window.CSSStyleDeclaration && !window.CSSStyleDeclaration.prototype[Symbol.iterator]) {
  window.CSSStyleDeclaration.prototype[Symbol.iterator] = function* () {
    for (let i = 0; i < this.length; i++) yield this.item(i);
  };
}
if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = function () {};
// jsdom 无 WAAPI(Element.animate);Electron/Chromium 原生具备,此处补环境缺口
// (设置页刷新闪烁反馈用,见 src/web/components/settings-page.tsx)。
if (!window.Element.prototype.animate) window.Element.prototype.animate = function () {
  return { cancel() {}, finish() {}, reverse() {}, play() {}, pause() {}, playState: "finished", finished: Promise.resolve(this), onfinish: null };
};
if (!window.HTMLElement.prototype.scrollTo) window.HTMLElement.prototype.scrollTo = function () {};
window.visualViewport = window.visualViewport ?? { width: 1280, height: 840, offsetLeft: 0, offsetTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} };
// 截图布局:jsdom 量高全 0 → virtuoso 渲染 0 条消息。给 virtuoso 各测量点报真实尺寸:
// 视口/scroller/列表容器报视口盒,消息条目按内容粗估。
const SCROLLER_H = 640, SCROLLER_W = 860;
const isVirtuosoBox = (el) => !!el?.closest?.("[data-virtuoso-scroller]") || el?.matches?.("[data-virtuoso-scroller]");
const isMsgItem = (el) => !!el?.closest?.("[data-message-id]");
const boxFor = (el) => {
  if (isMsgItem(el)) {
    const h = (el.textContent ?? "").length > 200 ? 120 : 64;
    return { w: SCROLLER_W, h };
  }
  if (isVirtuosoBox(el) || el?.matches?.("[data-virtuoso-scroller],[data-viewport-type],[data-testid='virtuoso-item-list']")) return { w: SCROLLER_W, h: SCROLLER_H };
  return null;
};
const mkRect = ({ w, h }) => ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON() { return this; } });
// react-virtuoso 的 RO 回调以 offsetParent!==null 为「已布局」闸门;jsdom 恒 null → 测量永不跑。
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get() { return this.parentElement ?? this.ownerDocument?.body ?? null; },
});
const origGBCR = window.Element.prototype.getBoundingClientRect;
window.Element.prototype.getBoundingClientRect = function () {
  const b = boxFor(this);
  return b ? mkRect(b) : origGBCR.call(this);
};
for (const prop of ["clientHeight", "offsetHeight"]) {
  Object.defineProperty(window.HTMLElement.prototype, prop, {
    configurable: true,
    get() { const b = boxFor(this); return b ? b.h : 0; },
  });
}
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get() { const b = boxFor(this); return b ? b.w : 0; },
});
if (!window.PointerEvent) window.PointerEvent = class PointerEvent extends window.MouseEvent {};
window.HTMLCanvasElement.prototype.getContext = window.HTMLCanvasElement.prototype.getContext ?? (() => null);

// WebSocket 内存垫片:双向桥到网关(同 ws-server 语义)
class InMemWebSocket {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this._ls = {};
    queueMicrotask(() => {
      this.readyState = 1;
      bridgeAttach(this); // 先挂服务端回调,再发 open——否则 open 冲刷的缓冲帧被丢(早期 invoke 全挂起)
      this._emit("open", {});
    });
  }
  addEventListener(t, cb) { (this._ls[t] ??= []).push(cb); }
  removeEventListener(t, cb) { this._ls[t] = (this._ls[t] ?? []).filter((f) => f !== cb); }
  send(data) { if (this.readyState === 1 && this._serverMessage) this._serverMessage(String(data)); }
  close() { if (this.readyState >= 2) return; this.readyState = 3; this._serverClose?.(); this._emit("close", {}); }
  _receive(text) { this._emit("message", { data: text }); }
  _emit(t, ev) { for (const cb of [...(this._ls[t] ?? [])]) cb(ev); }
}
window.WebSocket = InMemWebSocket;

// 全局面:bundle 模块级直接读裸全局
const G = globalThis;
const setGlobal = (k, v) => {
  try { G[k] = v; } catch { Object.defineProperty(G, k, { value: v, writable: true, configurable: true }); }
};
setGlobal('WebSocket', InMemWebSocket);
setGlobal('AbortController', window.AbortController);
setGlobal('AbortSignal', window.AbortSignal);
setGlobal('window', window);
setGlobal('document', window.document);
setGlobal('navigator', window.navigator);
setGlobal('location', window.location);
setGlobal('history', window.history);
setGlobal('localStorage', window.localStorage);
setGlobal('sessionStorage', window.sessionStorage);
setGlobal('self', window);
setGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
setGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
setGlobal('CustomEvent', window.CustomEvent);
setGlobal('Event', window.Event);
setGlobal('KeyboardEvent', window.KeyboardEvent);
setGlobal('MouseEvent', window.MouseEvent);
setGlobal('InputEvent', window.InputEvent);
setGlobal('PointerEvent', window.PointerEvent);
setGlobal('HTMLElement', window.HTMLElement);
setGlobal('HTMLTextAreaElement', window.HTMLTextAreaElement);
setGlobal('HTMLInputElement', window.HTMLInputElement);
setGlobal('Element', window.Element);
setGlobal('Node', window.Node);
setGlobal('MutationObserver', window.MutationObserver);
setGlobal('ResizeObserver', window.ResizeObserver);
setGlobal('IntersectionObserver', window.IntersectionObserver);
setGlobal('matchMedia', window.matchMedia);
setGlobal('DOMParser', window.DOMParser);
setGlobal('Image', window.Image);
setGlobal('SVGElement', window.SVGElement);
setGlobal('CSS', window.CSS ?? { supports: () => false, escape: (s) => s });
setGlobal('devicePixelRatio', 1);
setGlobal('innerWidth', 1280);
setGlobal('innerHeight', 840);
setGlobal('addEventListener', window.addEventListener.bind(window));
setGlobal('removeEventListener', window.removeEventListener.bind(window));
setGlobal('dispatchEvent', window.dispatchEvent.bind(window));

// 未捕获异常兜底:记录;致命与否按阶段判定(这里先全打印便于定位)
process.on("unhandledRejection", (reason) => {
  const msg = String(reason?.message ?? reason).slice(0, 300);
  report.consoleErrors.push(`[unhandledRejection] ${msg}`);
  origErr(`[unhandledRejection]`, reason?.stack ?? reason);
});
process.on("uncaughtException", (err) => {
  const msg = String(err?.message ?? err).slice(0, 300);
  report.consoleErrors.push(`[uncaughtException] ${msg}`);
  origErr(`[uncaughtException]`, err?.stack ?? err);
});
process.on("exit", (code) => { try { writeFileSync(join(OUT, "exit-code.txt"), String(code)); } catch {} });
process.on("beforeExit", (code) => { origErr(`[beforeExit] code=${code} (事件循环空)`); });

// console 错误采集
const origErr = console.error;
console.error = (...a) => { report.consoleErrors.push(a.map(String).join(" ").slice(0, 400)); origErr(...a); };
const origWarn = console.warn;
console.warn = (...a) => { report.consoleWarns.push(a.map(String).join(" ").slice(0, 400)); origWarn(...a); };
window.addEventListener("error", (e) => report.consoleErrors.push(`[window.error] ${String(e.message ?? e).slice(0, 300)}`));

// 加载真实入口 bundle
const entryMatch = readFileSync(join(ROOT, "out", "renderer", "index.html"), "utf-8").match(/src="\.\/(assets\/[^"]+\.js)"/);
if (!entryMatch) { console.error("index.html 未找到入口 script"); process.exit(1); }
const entryUrl = pathToFileURL(join(ROOT, "out", "renderer", entryMatch[1])).href;
log("加载 renderer bundle:", entryMatch[1]);
try {
  await import(entryUrl);
} catch (err) {
  check("前端: renderer bundle 加载", false, String(err.message ?? err));
  saveReport();
  process.exit(1);
}
check("前端: renderer bundle 加载", true, entryMatch[1]);

// 等 React 挂载 + 插件加载落定
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  const rootEl = window.document.getElementById("root");
  const hasComposer = !!window.document.querySelector("textarea[data-timeline-composer]");
  const hasSidebar = !!window.document.querySelector("[data-sidebar-style]");
  if (rootEl && rootEl.childElementCount > 0 && hasComposer && hasSidebar) break;
  await sleep(500);
}
await sleep(4000); // 插件 renderer 异步加载宽限
const doc = window.document;

// 诊断:invoke 延迟/挂起
{
  const done = new Set(invokeStats.latency.map((l) => l.id));
  const hanging = invokeStats.started.filter((x) => !done.has(x.id)).map((x) => `${x.channel}#${x.id}`);
  const slow = invokeStats.latency.filter((l) => l.ms > 500).map((l) => `${l.channel}#${l.id}=${l.ms}ms${l.ok ? "" : "!" + l.err}`);
  const failed = invokeStats.latency.filter((l) => !l.ok).map((l) => `${l.channel}#${l.id}:${l.err}`);
  log(`诊断: invoke 共 ${invokeStats.started.length} 个,挂起 ${hanging.length}:${hanging.slice(0, 12).join(", ")}`);
  if (slow.length) log(`诊断: 慢 invoke: ${slow.slice(0, 12).join(", ")}`);
  if (failed.length) log(`诊断: 失败 invoke: ${failed.slice(0, 12).join(", ")}`);
}
try {
  const res = await window.kernel.i18n.resources();
  const nsList = Object.keys(res?.resources ?? {});
  log(`诊断: i18n resources locales=${nsList.join(",")} shell键数=${JSON.stringify(res?.resources?.["zh-CN"]?.shell ? Object.keys(res.resources["zh-CN"].shell).length : null)}`);
} catch (e) { log("诊断: i18n resources 失败", e.message); }
// 诊断:currentCwd 链路
try {
  const lastCwdPref = await window.kernel.prefs.get("lastCwd");
  log(`诊断: prefs.lastCwd=${JSON.stringify(lastCwdPref)}  PROJECT_DIR=${PROJECT_DIR}`);
} catch (e) { log("诊断: prefs 读取失败", e.message); }
log(`诊断: body 文本前 400 字:${(doc.body.textContent ?? "").replace(/\s+/g, " ").slice(0, 400)}`);
const outline = [...doc.querySelectorAll("[data-sidebar-style],[data-sidepanel-style],textarea,main,[class*='sidebar']")].slice(0, 10)
  .map((el) => `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 60)}" data-sb="${el.getAttribute("data-sidebar-style") ?? ""}">`);
log(`诊断: 结构探针 ${outline.join(" | ")}`);
{
  // DOM 树概要(3 层)
  const dump = (el, depth) => {
    if (depth > 4) return "";
    const kids = [...el.children].map((c) => dump(c, depth + 1)).join("");
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" ? "." + el.className.split(/\s+/).slice(0, 2).join(".") : "";
    return `\n${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${id}${cls.slice(0, 40)}>${kids}`;
  };
  log(`诊断: DOM 树:${dump(doc.getElementById("root") ?? doc.body, 0).slice(0, 2500)}`);
}
// 诊断:invoke channel 全量
log(`诊断: invoke channels: ${invokeStats.latency.map((l) => l.channel).sort().join(", ").slice(0, 800)}`);

const elements = {
  rootChildren: doc.getElementById("root")?.childElementCount ?? 0,
  titlebar: !!doc.querySelector("div[class*='h-10'][class*='select-none']"),
  sidebar: !!doc.querySelector("[data-sidebar-style]"),
  sidepanel: !!doc.querySelector("[data-sidepanel-style]"),
  composer: !!doc.querySelector("textarea[data-timeline-composer]"),
  sessionNodes: doc.querySelectorAll("[data-session-path]").length,
  bodyTextLen: (doc.body.textContent ?? "").trim().length,
  lang: doc.documentElement.lang,
};
report.elements = elements;
check("页面: #root 已渲染", elements.rootChildren > 0, `children=${elements.rootChildren}`);
check("页面: 标题栏", elements.titlebar);
check("页面: 左栏 sidebar", elements.sidebar);
check("页面: 右栏 sidepanel", elements.sidepanel);
check("页面: 输入框 composer", elements.composer);
check("页面: 非黑屏", elements.bodyTextLen > 20, `bodyText ${elements.bodyTextLen} 字符, lang=${elements.lang}`);

// 插件加载验收(服务端注册表 + renderer 无失败 + DOM 贡献)
const pluginList = await window.kernel.plugins.list();
const byState = {};
for (const p of pluginList) byState[p.state] = (byState[p.state] ?? 0) + 1;
const notActive = pluginList.filter((p) => p.state !== "active");
const hostErrors = report.consoleErrors.filter((t) => t.includes("plugins-host") || t.includes("加载失败"));
report.plugins = { total: pluginList.length, byState, notActive: notActive.map((p) => `${p.id}(${p.state})`), ids: pluginList.map((p) => p.id).sort() };
check("插件: 内置全量在册(≥49)", pluginList.filter((p) => p.source === "builtin").length >= 49, `total=${pluginList.length}`);
check("插件: 全部 active", notActive.length === 0, notActive.length ? notActive.map((p) => p.id).join(",") : JSON.stringify(byState));
check("插件: renderer 无加载失败", hostErrors.length === 0, hostErrors.slice(0, 2).join(" | "));
check("插件: DOM 贡献落地(sidebar+sidepanel+composer 皆插件渲染)", elements.sidebar && elements.sidepanel && elements.composer);

// 组件注册验收:所有插件声明的组件必须注册成功(注册期警告=缺失),
// 且 DOM 不得出现 shell.componentNotRegistered 兜底(四语言文案全覆盖)。
const NOT_REGISTERED_TEXTS = ["组件未注册", "元件未註冊", "Komponente nicht registriert", "Component not registered"];
const fallbackHits = () => {
  const txt = doc.body.textContent ?? "";
  return NOT_REGISTERED_TEXTS.filter((s) => txt.includes(s));
};
const regWarns = report.consoleWarns.filter((t) => t.includes("registerPluginComponents") || t.includes("registerPluginMessageRenderers") || t.includes("未在 module exports"));
check("组件: 全部插件组件注册成功(零注册警告)", regWarns.length === 0, regWarns.length ? regWarns.slice(0, 2).join(" | ") : `warns=${report.consoleWarns.length} 皆非注册类`);
check("组件: DOM 零 componentNotRegistered 兜底(初始)", fallbackHits().length === 0, fallbackHits().join(",") || "无兜底文案");

// DOM 交互 1:右栏页签全量点击(每个页签组件都要真实挂载,不得落「组件未注册」兜底)
const sidepanelTabs = [...(doc.querySelector("[data-sidepanel-style]")?.querySelectorAll("button") ?? [])].filter((b) => b.checkVisibility());
const tabNames = [];
let tabFallback = null;
for (const btn of sidepanelTabs) {
  btn.click();
  await sleep(350);
  const name = btn.getAttribute("aria-label") ?? btn.title ?? btn.textContent?.trim().slice(0, 20) ?? "button";
  tabNames.push(name);
  const hits = fallbackHits();
  if (hits.length > 0) { tabFallback = `${name}: ${hits.join(",")}`; break; }
}
check("交互: 点击右栏页签", sidepanelTabs.length > 0 && !tabFallback,
  tabFallback ?? `${tabNames.length} 个页签全点: ${tabNames.join(", ")}`);

// DOM 交互 2:⌘, 打开设置(键盘 → 视图切换),再点「返回对话」(点击 → 切回)
const settingsWrapperOf = (el) => { let n = el; while (n && !(n.className?.toString().includes("absolute") && n.className?.toString().includes("inset-0"))) n = n.parentElement; return n; };
window.dispatchEvent(new window.KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true, bubbles: true, cancelable: true }));
await sleep(800);
const settingsOpen = !!doc.querySelector(".settings-content");
let backClicked = false;
let settingsItemsVisited = 0;
let settingsItemFallback = null;
if (settingsOpen) {
  // 全量遍历设置左栏条目:每个设置面板组件真实挂载一次,扫描未注册兜底
  const wrapper = settingsWrapperOf(doc.querySelector(".settings-content"));
  const settingsLeft = wrapper?.querySelector("[data-sidebar-style]");
  const scrollBox = [...(settingsLeft?.children ?? [])].find((c) => c.style.overflowY === "auto");
  const items = [...(scrollBox?.children ?? [])];
  for (const item of items) {
    item.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(350);
    settingsItemsVisited += 1;
    const hits = fallbackHits();
    if (hits.length > 0) { settingsItemFallback = `${item.textContent?.trim().slice(0, 20)}: ${hits.join(",")}`; break; }
  }
  // 「返回对话」是 ChatRow(div onClick),全文档找最深匹配节点
  const matches = [...doc.querySelectorAll("*")].filter((el) => (el.textContent ?? "").includes("返回对话"));
  const backEl = matches.length ? matches.reduce((a, b) => (a.contains(b) ? b : a)) : null;
  if (backEl) { backEl.click(); backClicked = true; }
  await sleep(800);
}
check("组件: 设置面板全量挂载零兜底", settingsOpen && settingsItemsVisited > 0 && !settingsItemFallback,
  settingsItemFallback ?? `遍历 ${settingsItemsVisited} 个设置项`);
// 设置页 wrapper 用 visibility 切换不卸载(保 ChatView 布局,见 src/web/index.tsx),
// 故「返回」的落地证据是设置 wrapper 变 hidden,而非节点移除。
const settingsWrapper = settingsWrapperOf(doc.querySelector(".settings-content"));
const settingsHiddenAfterBack = backClicked && settingsWrapper != null && settingsWrapper.style.visibility === "hidden";
check("交互: ⌘, 打开设置 + 点击返回", settingsOpen && settingsHiddenAfterBack,
  `设置打开=${settingsOpen} 返回点击=${backClicked} 返回后设置层visibility=${settingsWrapper?.style.visibility ?? "无wrapper"}`);

// ---------- 6. 发送 ping ----------
const events = [];
window.kernel.sessions.onEvent((e) => events.push({
  dt: Date.now(), type: e.type, role: e.message?.role,
  content: e.message?.content == null ? undefined
    : (typeof e.message.content === "string" ? e.message.content.slice(0, 500) : JSON.stringify(e.message.content).slice(0, 500)),
}));
const evStart = Date.now();

{
  const dl = Date.now() + 10000;
  while (!doc.querySelector("textarea[data-timeline-composer]") && Date.now() < dl) await sleep(300);
}
const ta = doc.querySelector("textarea[data-timeline-composer]");
if (!ta) {
  log(`诊断ping: textarea 数=${doc.querySelectorAll("textarea").length} [data-timeline-composer]=${doc.querySelectorAll("[data-timeline-composer]").length} body前300:${(doc.body.textContent ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
  const chatWrap = doc.querySelector("div[class*='h-full'][class*='flex']");
  log(`诊断ping: 主区结构 ${[...doc.querySelectorAll("[data-panel-id]")].map((p) => p.getAttribute("data-panel-id") + ":" + (p.textContent ?? "").slice(0, 40)).join(" | ").slice(0, 500)}`);
  check("ping: composer 可用", false, "textarea 缺失");
} else {
  ta.focus?.();
  ta.click?.();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "ping");
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(200);
  ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  log("ping 已提交(真实 composer → store → gateway → 内核)");

  // 等内核受理:事件流出现 sessionStart/messageStart/agentStart 任一,最长 120s(冷启动)
  const accepted = await (async () => {
    const dl = Date.now() + 120000;
    while (Date.now() < dl) {
      if (events.some((e) => ["sessionStart", "messageStart", "agentStart", "messageEnd"].includes(e.type))) return true;
      await sleep(500);
    }
    return false;
  })();
  check("ping: 内核受理事件", accepted, accepted ? `首个事件 ${events[0]?.type} @${(events[0]?.dt - evStart)}ms` : "120s 无事件");

  // 等 user 消息落定 / 轮结束(模型网络不通 → 尽力而为,再等 90s 收错误形态)
  const dl2 = Date.now() + 90000;
  while (Date.now() < dl2) {
    if (events.some((e) => ["agentSettled", "agentEnd"].includes(e.type))) break;
    if (events.some((e) => e.type === "messageEnd" && e.role === "assistant")) break;
    await sleep(500);
  }
  await sleep(1000);

  // 证据:隔离 HOME 里的会话文件出现 "ping"
  const sessionEvidence = [];
  const scanDir = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      try {
        if (ent.isDirectory()) scanDir(p);
        else if ((ent.name.endsWith(".jsonl") || ent.name.endsWith(".json")) && statSync(p).size < 2_000_000) {
          const txt = readFileSync(p, "utf-8");
          if (txt.includes('"ping"') || txt.includes("ping")) sessionEvidence.push(p.replace(E2E_HOME, "~"));
        } else if (ent.name.endsWith(".zstd")) {
          sessionEvidence.push(`${p.replace(E2E_HOME, "~")}(zstd,未解压)`);
        }
      } catch { /* skip */ }
    }
  };
  scanDir(join(E2E_HOME, ".pi", "agent", "sessions"));
  scanDir(join(E2E_HOME, ".my-harness-desktop-dev", "dsh", "sessions"));
  scanDir(join(E2E_HOME, ".my-harness-desktop-dev", "sessions"));
  report.ping = {
    events: events.map((e) => ({ ...e, dt: e.dt - evStart })),
    sessionFilesWithPing: sessionEvidence,
  };
  const userOut = events.some((e) => e.type === "messageStart" || e.type === "messageEnd");
  const assistantMsg = events.filter((e) => e.type === "messageEnd" && e.role === "assistant").pop();
  const assistantText = assistantMsg?.content && assistantMsg.content !== "[]" ? assistantMsg.content : "";
  if (assistantText) log(`assistant 回复内容: ${assistantText.slice(0, 300)}`);
  const assistantBack = !!assistantMsg && !!assistantText;
  check("ping: user 消息发出(事件流)", userOut, events.map((e) => e.type).join("→").slice(0, 300));
  check("ping: 会话文件落盘含 ping", sessionEvidence.length > 0, sessionEvidence.slice(0, 3).join(", ") || "未找到");
  check("ping: 模型回复(沙箱无网络,尽力而为)", assistantBack, assistantBack ? "收到 assistant 回复" : "沙箱禁外网,模型 API 不可达——发送链路本身已验真");
}

// ---------- 收尾 ----------
report.consoleErrors = report.consoleErrors.slice(0, 40);
check("组件: DOM 零 componentNotRegistered 兜底(终态)", fallbackHits().length === 0, fallbackHits().join(",") || "无兜底文案");
report.ok = report.checks.filter((c) => !c.name.includes("尽力而为")).every((c) => c.ok);

// ---------- 7. 截图序列化(可选):整页 DOM + 内联 CSS → 独立 HTML,供 WebKit 快照 ----------
if (globalThis.__roLog) log("RO 观察:", globalThis.__roLog.join(" | "));
if (process.env.MHD_SHOT) {
  const cssFiles = readdirSync(join(ROOT, "out", "renderer", "assets")).filter((f) => f.endsWith(".css"));
  const cssAll = cssFiles.map((f) => readFileSync(join(ROOT, "out", "renderer", "assets", f), "utf-8")).join("\n");
  const bodyHTML = doc.body.innerHTML;
  const htmlAttrs = doc.documentElement.getAttribute("style") ?? "";
  const bodyAttrs = doc.body.getAttribute("style") ?? "";
  const lang = doc.documentElement.getAttribute("lang") ?? "zh-CN";
  const page = `<!doctype html>
<html lang="${lang}" style="${htmlAttrs.replace(/"/g, "&quot;")}">
<head>
<meta charset="utf-8">
<style>html,body{height:100%;margin:0;overflow:hidden}</style>
<style>${cssAll}</style>
</head>
<body style="${bodyAttrs.replace(/"/g, "&quot;")}">
${bodyHTML}
</body>
</html>`;
  writeFileSync(process.env.MHD_SHOT, page);
  log(`截图页已写: ${process.env.MHD_SHOT} (${(page.length / 1024).toFixed(0)} KB)`);
}
try { await sessionStore.stopAll?.(); } catch { /* ignore */ }
saveReport();
log(`\n===== in-memory E2E: ${report.ok ? "ALL PASS ✅" : "存在失败项 ❌"} =====`);
for (const c of report.checks) if (!c.ok) log(`  FAIL ${c.name} — ${c.detail}`);
log(`报告: ${OUT}/report.json`);
process.exit(report.ok ? 0 : 1);
