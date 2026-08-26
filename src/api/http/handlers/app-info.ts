// 应用基本信息(web-service §20.6 HostApp)——经 conn.host.app,不再直接 import electron。
// local 连接 host = Electron(electron/chrome 填真值),remote/server 宿主 = 缺省降级(null)。
import type { Gateway } from "../../../core/application/remote/gateway";
import { IPC } from "@my-harness-desktop/shared";

export function registerAppInfo(gateway: Gateway): void {
  gateway.register(IPC.app.info, (conn) => conn.host.app.info());
  gateway.register(IPC.app.restart, (conn) => conn.host.app.restart());
}
