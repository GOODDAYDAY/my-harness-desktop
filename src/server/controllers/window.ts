// 窗口控制(web-service-architecture.md §20.2 HostWindow)——经 conn.host,不再 fromWebContents。
// Host 能力按连接身份:local 连接 host = Electron(§8.3),remote 连接 host = 缺省降级(UNSUPPORTED)。
import { IPC } from "@my-harness-desktop/shared";
import type { Gateway } from "../routing/gateway";

export function registerWindow(gateway: Gateway): void {
  gateway.register(IPC.window.minimize, (conn) => conn.host.window.minimize());
  gateway.register(IPC.window.toggleMaximize, (conn) => conn.host.window.toggleMaximize());
  gateway.register(IPC.window.close, (conn) => conn.host.window.close());
  gateway.register(IPC.window.isMaximized, (conn) => conn.host.window.isMaximized());
  gateway.register(IPC.window.isFocused, (conn) => conn.host.window.isFocused());
}
