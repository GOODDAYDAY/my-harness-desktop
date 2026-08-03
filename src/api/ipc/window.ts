// IPC:窗口控制 —— 无边框窗口在 win/linux 无原生标题栏按钮,renderer 自绘
// min/max/close 经此通道驱动;mac 红绿灯是原生的,不走这里。
// 窗口归属按事件来源定位(fromWebContents),不持全局窗口引用(多窗口各自正确)。
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../preload/ipc-channels";

export function registerWindowIpc(): void {
  const winOf = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle(IPC.window.minimize, (e) => { winOf(e)?.minimize(); });
  ipcMain.handle(IPC.window.toggleMaximize, (e) => {
    const w = winOf(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.handle(IPC.window.close, (e) => { winOf(e)?.close(); });
  ipcMain.handle(IPC.window.isMaximized, (e) => winOf(e)?.isMaximized() ?? false);
}

/** 窗口最大化状态推送:bootstrap createWindow 时挂上,renderer 据此切换 最大化/还原 图标。 */
export function attachWindowStateSync(win: BrowserWindow): void {
  win.on("maximize", () => { if (!win.isDestroyed()) win.webContents.send(IPC.window.maximizedChanged, true); });
  win.on("unmaximize", () => { if (!win.isDestroyed()) win.webContents.send(IPC.window.maximizedChanged, false); });
}
