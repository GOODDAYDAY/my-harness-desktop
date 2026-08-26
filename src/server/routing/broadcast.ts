// 广播助手 —— 配置写后/插件生命周期/kernel 状态变化时经 gateway.broadcast 推所有连接(WS)。
// 阶段 1 起 renderer 走 WS,不再有 webContents.send;此处统一走 gateway(§19.4)。
import { IPC } from "@my-harness-desktop/shared";
import type { Gateway } from "./gateway";

// 配置写后广播(根因修复:此前仅 skills:* 广播,设置页保存后订阅方如 debug-bar 永远收不到)
export function broadcastSettingsChanged(gateway: Gateway): void {
  gateway.broadcast("settings:changed");
}

// 通用刷新信号广播(装/升/降级内核、自定义内核路径变更等操作完成):消费方(会话流)
// 收到后重探挂载时探测的外部状态(根因修复:此前 timeline 的"未安装"只读条只在
// 挂载时探测一次,装完 pi 要重启才消失)。语义不绑具体资源——任何可能影响消费方
// 展示的操作完成后都可调,消费方订阅列表不随资源数膨胀。
export function broadcastRefreshRequested(gateway: Gateway): void {
  gateway.broadcast(IPC.refresh.requested);
}

let pluginsNonceCounter = 0;

export function notifyPluginsChanged(gateway: Gateway): void {
  pluginsNonceCounter++;
  gateway.broadcast("plugins:changed", pluginsNonceCounter);
}

export function notifyPluginUnloaded(gateway: Gateway, pluginId: string, components: string[]): void {
  gateway.broadcast("plugin:unloaded", { pluginId, components });
}
