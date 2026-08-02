// IPC:Session Bus 插件面 —— sessions:bus 声明权限门控,全部 handler 转调 SessionBus。
// 插件的 from = plugin:<id>(框架注入,不自报);路由/房间/tap 的实现全在 router,
// 本文件只做权限检查 + 参数传递,零业务逻辑。
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

  ipcMain.handle(IPC.bus.send, (_e, pluginId: string, to: string, kind: string, payload: unknown) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginSend(pluginId, to, kind, payload);
  });
  ipcMain.handle(IPC.bus.publish, (_e, pluginId: string, channel: string, kind: string, payload: unknown) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginSend(pluginId, `channel:${channel}`, kind, payload);
  });
  ipcMain.handle(IPC.bus.join, (_e, pluginId: string, channel: string, member?: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginJoin(pluginId, channel, member);
  });
  ipcMain.handle(IPC.bus.leave, (_e, pluginId: string, channel: string, member?: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginLeave(pluginId, channel, member);
  });
  ipcMain.handle(IPC.bus.members, (_e, pluginId: string, channel: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginMembers(channel);
  });
  ipcMain.handle(IPC.bus.channelList, (_e, pluginId: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginChannelList();
  });
  ipcMain.handle(IPC.bus.sessions, (_e, pluginId: string) => {
    assertBusPermission(pluginId);
    return sessionBus.opSessions();
  });
  ipcMain.handle(IPC.bus.whoami, (_e, pluginId: string) => {
    assertBusPermission(pluginId);
    return sessionBus.opWhoami(`plugin:${pluginId}`);
  });
  ipcMain.handle(IPC.bus.tapStart, (_e, pluginId: string, opts: Record<string, unknown>) => {
    assertBusPermission(pluginId);
    return sessionBus.opTapStart(`plugin:${pluginId}`, opts);
  });
  ipcMain.handle(IPC.bus.tapStop, (_e, pluginId: string, tapId: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginTapStop(tapId);
  });
  ipcMain.handle(IPC.bus.tapList, (_e, pluginId: string) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginTapList(`plugin:${pluginId}`);
  });
  ipcMain.handle(IPC.bus.sessionCreate, (_e, pluginId: string, opts: Record<string, unknown>) => {
    assertBusPermission(pluginId);
    return sessionBus.pluginSessionCreate(pluginId, opts);
  });
  ipcMain.handle(IPC.bus.sessionAbort, (_e, pluginId: string, session: string) => {
    assertBusPermission(pluginId);
    return sessionBus.opSessionAbort(`plugin:${pluginId}`, session);
  });
}
