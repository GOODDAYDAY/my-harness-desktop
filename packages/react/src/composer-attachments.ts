import { useEffect, useState } from "react";
import type { ComposerAttachmentContribution, ComposerAttachmentPayload } from "@my-harness-desktop/contract";
import { useUiStore } from "../../../src/api/renderer/stores/ui-store";

export type ComposerAttachmentItem = ComposerAttachmentContribution & { pluginId: string };

/** 槽组件 props 契约:挂载数据(timeline 持有时经 payload 传入)。
 *  发送完成收尾由贡献方自行感知(如订阅框架 store 的 lastSendNonce),不进 props。 */
export interface ComposerAttachmentProps {
  payload: ComposerAttachmentPayload;
}

let cache: { nonce: number; data: ComposerAttachmentItem[] } | null = null;

/** 查 composerAttachments 槽全部贡献(镜像 useComposerPolicies:同 nonce 单发,失效重拉)。 */
export function useComposerAttachments(): ComposerAttachmentItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<ComposerAttachmentItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.composerAttachments().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}
