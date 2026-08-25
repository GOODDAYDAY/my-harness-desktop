// composerStats 槽的 renderer 侧查询 hook(机械镜像 useComposerActions:
// 同 nonce 单发,失效重拉)。消费方(timeline)查槽后按 getPluginComponent 匹配组件,
// 渲染进 Composer 中段的统计指示区(上下文占用条等)。组件 props 无(自订阅框架 store)。
import { useEffect, useState } from "react";
import type { ComposerStatsContribution } from "@my-harness-desktop/contract";
import { useUiStore } from "../../../src/api/renderer/stores/ui-store";

export type ComposerStatsItem = ComposerStatsContribution & { pluginId: string };

let cache: { nonce: number; data: ComposerStatsItem[] } | null = null;

/** 查 composerStats 槽全部贡献(状态指示组件自订阅 store,props 无)。 */
export function useComposerStats(): ComposerStatsItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<ComposerStatsItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.composerStats().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}
