// renderer 广播助手 —— 配置写后/插件生命周期/kernel 状态变化时推所有窗口。
import { BrowserWindow } from "electron";
import { IPC } from "../preload/ipc-channels";

// 配置写后广播(根因修复:此前仅 skills:* 广播,设置页保存后订阅方如 debug-bar 永远收不到)
export function broadcastSettingsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("settings:changed");
}

// 通用刷新信号广播(装/升/降级底座、自定义底座路径变更等操作完成):消费方(会话流)
// 收到后重探挂载时探测的外部状态(根因修复:此前 timeline 的"未安装"只读条只在
// 挂载时探测一次,装完 pi 要重启才消失)。语义不绑具体资源——任何可能影响消费方
// 展示的操作完成后都可调,消费方订阅列表不随资源数膨胀。
export function broadcastRefreshRequested(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.refresh.requested);
}

let pluginsNonceCounter = 0;

export function notifyPluginsChanged(): void {
  pluginsNonceCounter++;
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send("plugins:changed", pluginsNonceCounter);
  }
}

export function notifyPluginUnloaded(pluginId: string, components: string[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send("plugin:unloaded", { pluginId, components });
  }
}
