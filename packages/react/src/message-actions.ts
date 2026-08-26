import { useEffect, useState } from "react";
import type { MessageActionContribution } from "@my-harness-desktop/shared";
import { getPluginComponent, asReactComponent } from "./plugin-modules";
import { useUiStore } from "../../../src/web/stores/ui-store";

export type MessageActionItem = MessageActionContribution & { pluginId: string };

export interface MessageActionProps {
  message: import("@my-harness-desktop/shared").NeutralMessage;
  text: string;
}

let cache: { nonce: number; data: MessageActionItem[] } | null = null;

export function useMessageActions(): MessageActionItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<MessageActionItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.messageActions().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}

export function resolveMessageActionComponent(pluginId: string, component: string): React.ComponentType<MessageActionProps> | undefined {
  return asReactComponent(getPluginComponent(pluginId, component)) as React.ComponentType<MessageActionProps> | undefined;
}
