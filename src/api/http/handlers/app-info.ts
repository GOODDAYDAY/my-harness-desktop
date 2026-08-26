// IPC:应用基本信息 —— renderer 经此拿到 app name/version/electron/node/chrome/platform。
// 这些值 main 进程独有(app.getVersion 读 package.json、app.isPackaged 区分打包态),
// renderer 无法自行获取,走 IPC 受控暴露。
import { app,  } from "electron";
import type { Gateway } from "../../../core/application/remote/gateway";
import { IPC } from "../../../core/domain/channel-contract";

export function registerAppInfo(gateway: Gateway): void {
  gateway.register(IPC.app.info, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    isPackaged: app.isPackaged,
  }));

  // 整 App 重启。必须 app.quit() 而非 app.exit(0):只有前者触发 bootstrap 的
  // before-quit 回收链(stopAll kill 链),否则 pi 子进程成孤儿。
  gateway.register(IPC.app.restart, () => {
    app.relaunch();
    app.quit();
  });
}
