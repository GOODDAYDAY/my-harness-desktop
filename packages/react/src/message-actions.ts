import { useEffect, useState } from "react";
import type { MessageActionContribution } from "@pi-desktop/contract";
import { eventBus } from "./event-bus";
import { useUiStore } from "../../../src/api/renderer/stores/ui-store";

export type MessageActionItem = MessageActionContribution & { pluginId: string };

export function messageActionInvokeChannel(pluginId: string): string {
  return `${pluginId}:messageActionInvoke`;
}

export interface MessageActionInvokePayload {
  actionId: string;
  sessionPath: string;
  entryId: string;
  preview: string;
}

let cache: { nonce: number; data: MessageActionItem[] } | null = null;

export function useMessageActions(): MessageActionItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<MessageActionItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.pi.slots.messageActions().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}

async function revealPluginSidePanel(pluginId: string): Promise<void> {
  const items = await window.pi.slots.sidePanel();
  const item = items.find((i) => i.pluginId === pluginId);
  if (!item) return;
  const s = useUiStore.getState();
  if (!s.activeSidePanelTabs.includes(item.id)) {
    s.toggleSidePanelTab(item.id);
  }
}

export function invokeMessageAction(
  callerId: string,
  action: MessageActionItem,
  target: { sessionPath: string; entryId: string; preview: string },
): void {
  void revealPluginSidePanel(action.pluginId);
  const payload: MessageActionInvokePayload = { actionId: action.id, ...target };
  eventBus.invoke(callerId, messageActionInvokeChannel(action.pluginId), payload);
}
