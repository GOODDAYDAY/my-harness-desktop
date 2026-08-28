// web 服务化启动引导(§4.4)——window.kernel 由 WS 构建,不再 contextBridge 注入。
// 必须作为 index.tsx 的第一个 import 执行:titlebar 等组件在模块级读
// window.kernel.platform(§16.2),ES import 先于模块体执行,故引导须独立成模块先跑。
import { wsTransport } from "./transport/ws-transport";
import { buildKernel } from "./kernel/build-kernel";

// crypto.randomUUID 补齐(第 17 项真凶):浏览器只在安全上下文(https/localhost)暴露
// randomUUID——经局域网 http 地址访问时它是 undefined,发消息等一切生成 id 的操作全炸。
// 用 getRandomValues(不受安全上下文限制)实现 UUIDv4 补上,一处覆盖全部调用点。
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  const uuidv4 = (): string => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  try {
    Object.defineProperty(Object.getPrototypeOf(crypto), "randomUUID", { value: uuidv4, configurable: true, writable: true });
  } catch {
    (crypto as unknown as { randomUUID: () => string }).randomUUID = uuidv4;
  }
}

// 平台自判(web-service-architecture.md §20.7):preload 时代 window.kernel.platform =
// process.platform("darwin"/"win32"/"linux")。web 化删 preload 后 renderer 无 Node 访问,
// 只能从浏览器侧自判 OS 并归一化到 process.platform 约定——navigator.platform 在 macOS
// 返回 "MacIntel"(而非 "darwin"),titlebar 的 isMac = platform === "darwin" 因此失效,
// 红绿灯让位 padding 丢失,面包屑左移压到 mac 三按钮上(根因:直接传 navigator.platform)。
function detectClientPlatform(): string {
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const raw = uad?.platform || navigator.platform || "";
  const v = raw.toLowerCase();
  if (v.includes("mac")) return "darwin";
  if (v.includes("win")) return "win32";
  if (v.includes("linux")) return "linux";
  return raw || "unknown";
}

// 本地身份由 URL ?lt=<token> 判定(§8.3)。hello 鉴权由传输层收口:open 先发 hello,
// 鉴权通过前业务帧全部缓冲——引导期模块级 invoke 不可能冲在 hello 之前(黑屏根因修复)。
// 远程浏览器经登录门拿到凭证后重载;URL 也可携带 ?token=(登录返回的 HMAC token,
// 供无 cookie 环境复用)——凭证经 hello 传递,密码本身永不进 URL(§8.1)。
const params = new URLSearchParams(location.search);
const lt = params.get("lt") ?? undefined;
const urlToken = params.get("token") ?? undefined;
// 本机窗口(?lt 存在):客户端 OS 即宿主 OS,按 process.platform 约定归一化;远程浏览器:
// 前端自判 "browser"(§20.7 无原生红绿灯/窗口控制,titlebar 按非 mac 渲染)。
const platform = lt ? detectClientPlatform() : "browser";

// 断连横幅(第 17 项):应用重启/退出后页面还开着,输入框仍能动但一切操作无响应——
// 静默即「根本无法交互」。传输层挂起请求已显式失败,这里补页面级可见性:横幅 + 刷新按钮。
function showDisconnectedBanner(): void {
  if (document.getElementById("mhd-disconnected")) return;
  const el = document.createElement("div");
  el.id = "mhd-disconnected";
  el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100000;" +
    "display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:10px;" +
    "background:var(--color-accent-danger,#c23430);color:#fff;font-size:14px;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.25);";
  const msg = document.createElement("span");
  msg.textContent = "与服务端的连接已断开(应用重启或网络切换) · Connection lost";
  const btn = document.createElement("button");
  btn.textContent = "刷新页面 Reload";
  btn.style.cssText = "padding:4px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.6);" +
    "background:transparent;color:#fff;cursor:pointer;font-size:13px;";
  btn.addEventListener("click", () => location.reload());
  el.append(msg, btn);
  document.body.appendChild(el);
}

const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`);
window.kernel = buildKernel(wsTransport(ws, { token: lt ?? urlToken, onDisconnect: showDisconnectedBanner }), platform);
