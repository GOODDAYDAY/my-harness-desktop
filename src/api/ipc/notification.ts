// IPC:系统通知 —— main 进程 Electron Notification(mac 通知中心 / win toast / linux libnotify)。
//
// 纯机制:不含任何文案,文案由调用方(notifier 插件)经 i18n 传进来。isSupported() 降级——
// Linux 无通知守护进程时静默不发,不抛错(环境能力缺失,不是操作失败)。
// click → 唤起并聚焦来源窗口(Wayland 下 focus 可能被合成器限制,属已知边界)。
import { BrowserWindow, ipcMain, Notification } from "electron";
import { IPC } from "../preload/ipc-channels";

/** 通知载荷(壳自有能力,不进圆心契约)。 */
interface NotifyPayload {
  title: string;
  body: string;
  silent?: boolean;
}

export function registerNotificationIpc(): void {
  ipcMain.handle(IPC.notification.show, (e, payload: NotifyPayload) => {
    if (!Notification.isSupported()) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    const n = new Notification({
      title: payload.title,
      body: payload.body,
      silent: payload.silent ?? false,
    });
    n.on("click", () => {
      win?.show();
      win?.focus();
    });
    n.show();
  });
}
