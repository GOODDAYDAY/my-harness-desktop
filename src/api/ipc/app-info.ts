// IPC:应用基本信息 —— renderer 经此拿到 app name/version/electron/node/chrome/platform。
// 这些值 main 进程独有(app.getVersion 读 package.json、app.isPackaged 区分打包态),
// renderer 无法自行获取,走 IPC 受控暴露。
import { app, ipcMain } from "electron";
import { IPC } from "../preload/ipc-channels";

export function registerAppInfoIpc(): void {
  ipcMain.handle(IPC.app.info, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    isPackaged: app.isPackaged,
  }));
}
