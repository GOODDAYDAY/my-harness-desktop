// web 服务化启动引导(§4.4)——window.kernel 由 WS 构建,不再 contextBridge 注入。
// 必须作为 index.tsx 的第一个 import 执行:titlebar 等组件在模块级读
// window.kernel.platform(§16.2),ES import 先于模块体执行,故引导须独立成模块先跑。
import { wsTransport } from "./transport/ws-transport";
import { buildKernel } from "./kernel/build-kernel";

// 本地身份由 URL ?lt=<token> 判定(§8.3),WS open 后 hello 鉴权;invoke 帧在连接期缓冲。
const lt = new URLSearchParams(location.search).get("lt") ?? undefined;
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`);
window.kernel = buildKernel(wsTransport(ws), navigator.platform);
ws.addEventListener("open", () => {
  if (lt) ws.send(JSON.stringify({ kind: "hello", token: lt }));
});
