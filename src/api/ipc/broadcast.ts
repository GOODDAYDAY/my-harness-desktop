// renderer 广播助手 —— 配置写后/插件生命周期变化时推所有窗口。
import { BrowserWindow } from "electron";

// 配置写后广播(根因修复:此前仅 skills:* 广播,设置页保存后订阅方如 debug-bar 永远收不到)
export function broadcastSettingsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("settings:changed");
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
