// IPC:内核拓展管理(kernelExtensions.*,按 kernel 作用域)+ restart 协调(restart.*)。
// 中性契约:同一组 channel,按 kernel 参数分派到对应 KernelExtensionSource;加第三个内核
// 只加 bootstrap 组装,本文件不改。
import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../preload/ipc-channels";
import type { MainContext } from "./main-context";
import type { KernelId } from "../../core/domain/kernel";

export function registerExtensionsIpc(ctx: MainContext): void {
  const { kernelExtensions, sessionStore, restartCoordinator } = ctx;

  const manager = (kernel: KernelId) => {
    const m = kernelExtensions[kernel];
    if (!m) throw new Error(`未知内核: ${kernel}`);
    return m;
  };

  ipcMain.handle(IPC.kernelExtensions.list, (_e, kernel: KernelId) => manager(kernel).list());
  ipcMain.handle(IPC.kernelExtensions.enable, (_e, kernel: KernelId, id: string) => manager(kernel).enable(id));
  ipcMain.handle(IPC.kernelExtensions.disable, (_e, kernel: KernelId, id: string) => manager(kernel).disable(id));
  ipcMain.handle(IPC.kernelExtensions.install, (e, kernel: KernelId, source: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return manager(kernel).install(source, (line) => win?.webContents.send(IPC.kernelExtensions.installProgress, line));
  });
  ipcMain.handle(IPC.kernelExtensions.uninstall, (e, kernel: KernelId, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return manager(kernel).uninstall(id, (line) => win?.webContents.send(IPC.kernelExtensions.installProgress, line));
  });

  // ---- IPC: restart 协调(§6.4) ----
  ipcMain.handle(IPC.restart.pendingSessions, () => {
    const keys = sessionStore.getRunningSessionKeys();
    return keys.map((k) => ({ sessionKey: k, state: restartCoordinator.getState(k) }));
  });
  ipcMain.handle(IPC.restart.restart, (_e, sessionKey: string) => restartCoordinator.restart(sessionKey));
  ipcMain.handle(IPC.restart.restartAllIdle, () => restartCoordinator.restartIdlePending());
}
