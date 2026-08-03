// IPC:Session Bus 插件面 —— sessions:bus 声明权限门控,全部 handler 转调 SessionBus。
// 插件的 from = plugin:<id>(框架注入,不自报);路由/房间/tap 的实现全在 router,
// 本文件只做权限检查 + 参数传递,零业务逻辑。
// 能力面与 bus-extension 的 7 个 tool 同一组 op(契约单源):status/send/sessionCreate/
// sessionAbort/channelMember/tapStart/tapStop;publish/reply 是 send 的参数化,不单列。
import { ipcMain } from "electron";
import { IPC } from "../preload/ipc-channels";
import type { MainContext } from "./main-context";

export function registerBusIpc(ctx: MainContext): void {
  const { registry, sessionBus } = ctx;

  function assertBusPermission(pluginId: string): void {
    if (!registry.manifestOf(pluginId)) throw new Error(`未知插件: ${pluginId}`);
    if (!registry.hasPermission(pluginId, "sessions:bus")) {
      throw new Error(`插件 ${pluginId} 未声明权限 sessions:bus`);
    }
  }

  ipcMain.handle(IPC.bus.status, (_e, pluginId: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginStatus(pluginId);
  });
  ipcMain.handle(IPC.bus.send, (_e, pluginId: string, to: string, kind: string, payload: unknown, replyTo?: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginSend(pluginId, to, kind, payload, replyTo);
  });
  ipcMain.handle(IPC.bus.sessionCreate, (_e, pluginId: string, opts: Record<string, unknown>) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginSessionCreate(pluginId, opts);
  });
  ipcMain.handle(IPC.bus.sessionAbort, (_e, pluginId: string, session: string) => {
    assertBusPermission(pluginId);
    return sessionBus.opSessionAbort(`plugin:${pluginId}`, session);
  });
  ipcMain.handle(IPC.bus.channelMember, (_e, pluginId: string, channel: string, action: "join" | "leave", member?: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginChannelMember(pluginId, channel, action, member);
  });
  ipcMain.handle(IPC.bus.tapStart, (_e, pluginId: string, opts: Record<string, unknown>) => {
    assertBusPermission(pluginId);
    return sessionBus.opTapStart(`plugin:${pluginId}`, opts);
  });
  ipcMain.handle(IPC.bus.tapStop, (_e, pluginId: string, tapId: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginTapStop(tapId);
  });
}
