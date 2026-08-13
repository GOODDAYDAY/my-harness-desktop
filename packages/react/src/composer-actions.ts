// composerActions 槽的 renderer 侧查询 hook(机械镜像 useComposerAttachments:
// 同 nonce 单发,失效重拉)。消费方(timeline)查槽后按 getPluginComponent 匹配组件,
// 渲染进 Composer 底部工具栏的 children 渲染点(设计 docs/design/sticker-plugin.md §5.1)。
import { useEffect, useState } from "react";
import type { ComposerActionContribution } from "@pi-desktop/contract";
import { useUiStore } from "../../../src/api/renderer/stores/ui-store";

export type ComposerActionItem = ComposerActionContribution & { pluginId: string };

let cache: { nonce: number; data: ComposerActionItem[] } | null = null;

/** 查 composerActions 槽全部贡献(按钮组件自持点击/弹窗,props 无)。 */
export function useComposerActions(): ComposerActionItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<ComposerActionItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.pi.slots.composerActions().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}
