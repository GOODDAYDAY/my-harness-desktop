// composerTop 槽的 renderer 侧查询 hook(机械镜像 useComposerStats:
// 同 nonce 单发,失效重拉)。消费方(timeline)查槽后按 getPluginComponent 匹配组件,
// 渲染进输入框上方的 ComposerDock 顶部(目标条等进行态展示)。组件 props 无(自订阅插件内状态)。
import { useEffect, useState } from "react";
import type { ComposerTopContribution } from "@my-harness-desktop/shared";
import { useUiStore } from "../../../src/web/stores/ui-store";

export type ComposerTopItem = ComposerTopContribution & { pluginId: string };

let cache: { nonce: number; data: ComposerTopItem[] } | null = null;

/** 查 composerTop 槽全部贡献(横幅组件自订阅插件内状态,props 无)。 */
export function useComposerTop(): ComposerTopItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<ComposerTopItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.composerTop().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}
