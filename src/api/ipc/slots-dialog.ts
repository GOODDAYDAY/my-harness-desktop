// IPC:槽位清单 + 系统对话框 + 系统文件管理器集成(openFile/revealPath)。
import { ipcMain, BrowserWindow, shell, dialog } from "electron";
import { join, extname } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { IPC } from "../preload/ipc-channels";
import type { MainContext } from "./main-context";

export function registerSlotsDialogIpc(ctx: MainContext): void {
  const { registry } = ctx;

  ipcMain.handle(IPC.slots.sidePanel, () => registry.sidePanelItems());
  ipcMain.handle(IPC.slots.sidebar, () => registry.sidebarItems());
  ipcMain.handle(IPC.slots.mainView, () => registry.mainViewItems());
  ipcMain.handle(IPC.slots.titlebar, () => registry.titlebarItems());
  ipcMain.handle(IPC.slots.fileActions, () => registry.fileActionItems());
  ipcMain.handle(IPC.slots.fileIcons, () => registry.fileIconItems());
  ipcMain.handle(IPC.slots.messageActions, () => registry.messageActionItems());
  ipcMain.handle(IPC.slots.sessionGroupings, () => registry.sessionGroupingItems());
  ipcMain.handle(IPC.slots.composerPolicies, () => registry.composerPolicyItems());
  ipcMain.handle(IPC.slots.settingsGroups, () => registry.settingsGroupItems());

  // ---- IPC:对话框 ----
  ipcMain.handle(IPC.dialog.openDirectory, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp",
  };
  ipcMain.handle(IPC.dialog.openImages, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled) return [];
    const out: { name: string; data: string; mimeType: string }[] = [];
    for (const p of result.filePaths) {
      const mimeType = IMAGE_MIME[extname(p).toLowerCase()];
      if (!mimeType) continue;
      if (statSync(p).size > 10 * 1024 * 1024) continue; // 单张 10MB 上限
      out.push({ name: p.split("/").pop() ?? p, data: readFileSync(p).toString("base64"), mimeType });
    }
    return out;
  });

  // ---- IPC:用系统默认编辑器打开文件(框架"打开配置"按钮用)----
  ipcMain.handle(IPC.misc.openFile, async (_e, path: string) => {
    // 展开 ~ 为家目录(shell.openPath 要绝对路径)
    const abs = path.startsWith("~/") ? join(ctx.paths.homeDir, path.slice(2)) : path;
    const r = await shell.openPath(abs);
    if (r) console.warn("[main] openPath failed:", abs, r);
    return r;
  });

  // ---- IPC:在系统文件管理器中显示(与 openFile 同敏感度级:核心默认,不门控)----
  ipcMain.handle(IPC.misc.revealPath, (_e, path: string) => {
    const abs = path.startsWith("~/") ? join(ctx.paths.homeDir, path.slice(2)) : path;
    shell.showItemInFolder(abs);
  });
}
