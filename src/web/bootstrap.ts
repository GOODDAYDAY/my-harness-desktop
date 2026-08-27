// web 服务化启动引导(§4.4)——window.kernel 由 WS 构建,不再 contextBridge 注入。
// 必须作为 index.tsx 的第一个 import 执行:titlebar 等组件在模块级读
// window.kernel.platform(§16.2),ES import 先于模块体执行,故引导须独立成模块先跑。
import { wsTransport } from "./transport/ws-transport";
import { buildKernel } from "./kernel/build-kernel";

// 本地身份由 URL ?lt=<token> 判定(§8.3)。hello 鉴权由传输层收口:open 先发 hello,
// 鉴权通过前业务帧全部缓冲——引导期模块级 invoke 不可能冲在 hello 之前(黑屏根因修复)。
const lt = new URLSearchParams(location.search).get("lt") ?? undefined;
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`);
window.kernel = buildKernel(wsTransport(ws, { token: lt }), navigator.platform);
