// file-actions.ts —— fileActions 槽的 renderer 侧机制:查询、约定频道、invoke 触发。
//
// 三段式机制(domain/contributions.ts FileActionContribution 注释钉的契约):
// ① 声明:贡献者在 plugin.json 写 contributes.fileActions(静态,与 sidePanel 同构);
// ② 消费:文件树等经 useFileActions() 查槽渲染菜单(pluginsNonce 失效重拉);
// ③ 触发:invokeFileAction 把 invoke 路由到贡献者的 <pluginId>:fileActionInvoke 约定频道,
//    并自动浮出贡献者的 sidePanel tab——懒挂载组件挂载后订阅,eventBus 队列冲刷送达。
// 双向解耦:消费方不认识贡献方(动作清单来自内核注册表),贡献方不认识消费方(只收 invoke)。
import { useEffect, useState } from "react";
import type { FileActionContribution } from "@my-harness-desktop/shared";
import { eventBus } from "./event-bus";
import { useUiStore } from "../../../src/web/stores/ui-store";

/** fileActions 槽查询项:贡献声明 + 来源 pluginId(registry.fileActionItems 的运行时形态)。 */
export type FileActionItem = FileActionContribution & { pluginId: string };

/** invoke 约定频道:贡献者在自己的 channels export 里声明这一个频道,收本插件所有动作。 */
export function fileActionInvokeChannel(pluginId: string): string {
  return `${pluginId}:fileActionInvoke`;
}

export interface FileActionInvokePayload {
  actionId: string;
  path: string;
  isDir: boolean;
  cwd: string;
}

let cache: { nonce: number; data: FileActionItem[] } | null = null;

/** 查 fileActions 槽全部贡献(镜像 right-panel 的 useSidePanelData:同 nonce 单发,失效重拉)。 */
export function useFileActions(): FileActionItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<FileActionItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.fileActions().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}

/** 浮出贡献者的 sidePanel tab(有 sidePanel 贡献才浮出;没有则 invoke 仍经队列等订阅)。 */
async function revealPluginSidePanel(pluginId: string): Promise<void> {
  const items = await window.kernel.slots.sidePanel();
  const item = items.find((i) => i.pluginId === pluginId);
  if (!item) return;
  const s = useUiStore.getState();
  if (!s.activeSidePanelTabs.includes(item.id)) {
    s.toggleSidePanelTab(item.id);
  }
}

/** 触发一个文件动作:先浮出贡献者 UI(触发挂载 → 订阅),再把 invoke 路由过去。 */
export function invokeFileAction(
  callerId: string,
  action: FileActionItem,
  target: { path: string; isDir: boolean; cwd: string },
): void {
  void revealPluginSidePanel(action.pluginId);
  const payload: FileActionInvokePayload = { actionId: action.id, ...target };
  eventBus.invoke(callerId, fileActionInvokeChannel(action.pluginId), payload);
}
