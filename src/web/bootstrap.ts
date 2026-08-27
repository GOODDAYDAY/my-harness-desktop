// web 服务化启动引导(§4.4)——window.kernel 由 WS 构建,不再 contextBridge 注入。
// 必须作为 index.tsx 的第一个 import 执行:titlebar 等组件在模块级读
// window.kernel.platform(§16.2),ES import 先于模块体执行,故引导须独立成模块先跑。
import { wsTransport } from "./transport/ws-transport";
import { buildKernel } from "./kernel/build-kernel";

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
const lt = new URLSearchParams(location.search).get("lt") ?? undefined;
// 本机窗口(?lt 存在):客户端 OS 即宿主 OS,按 process.platform 约定归一化;远程浏览器:
// 前端自判 "browser"(§20.7 无原生红绿灯/窗口控制,titlebar 按非 mac 渲染)。
const platform = lt ? detectClientPlatform() : "browser";
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`);
window.kernel = buildKernel(wsTransport(ws, { token: lt }), platform);
