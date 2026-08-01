// IPC:extension 管理(extension.*)+ restart 协调(restart.*)。
import { ipcMain, BrowserWindow } from "electron";
import { runPiCli } from "../../client/pi/pi-cli";
import { IPC } from "../preload/ipc-channels";
import type { MainContext } from "./main-context";

export function registerExtensionsIpc(ctx: MainContext): void {
  const { extensionStore, sessionStore, restartCoordinator } = ctx;

  ipcMain.handle(IPC.extension.list, () => extensionStore.scanExtensions());
  ipcMain.handle(IPC.extension.enable, (_e, source: string) => extensionStore.enable(source));
  ipcMain.handle(IPC.extension.disable, (_e, source: string) => extensionStore.disable(source));
  ipcMain.handle(IPC.extension.reorder, (_e, sources: string[]) => extensionStore.reorder(sources));

  ipcMain.handle(IPC.extension.install, async (e, source: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return runPiCli(["install", source], (line) => win?.webContents.send("extension:install-progress", line));
  });
  ipcMain.handle(IPC.extension.update, async (e, source: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return runPiCli(["update", source], (line) => win?.webContents.send("extension:install-progress", line));
  });
  ipcMain.handle(IPC.extension.remove, async (e, source: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return runPiCli(["remove", source], (line) => win?.webContents.send("extension:install-progress", line));
  });

  // ---- IPC: restart 协调(§6.4) ----
  ipcMain.handle(IPC.restart.pendingSessions, () => {
    const keys = sessionStore.getRunningSessionKeys();
    return keys.map((k) => ({ sessionKey: k, state: restartCoordinator.getState(k) }));
  });
  ipcMain.handle(IPC.restart.restart, (_e, sessionKey: string) => restartCoordinator.restart(sessionKey));
  ipcMain.handle(IPC.restart.restartAllIdle, () => restartCoordinator.restartIdlePending());
}
