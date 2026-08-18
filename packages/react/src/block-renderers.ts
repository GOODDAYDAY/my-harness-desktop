// block-renderers.ts —— blockRenderers 槽的 renderer 侧机制:查询、(block, name?) 二键解析、组件匹配。
//
// 三段式机制(docs/design/timeline-block-renderers.md §3.3):
// ① 声明:贡献者在 plugin.json 写 contributes.blockRenderers(静态,与 messageActions 同构);
// ② 消费:timeline 经 useBlockRenderers() 查槽(pluginsNonce 失效重拉,同 nonce 单发);
// ③ 渲染:resolveBlockRenderer 按解析规则定贡献项,getPluginComponent 按名匹配插件 exports。
// 双向解耦:timeline 不认识贡献方(清单来自内核注册表),贡献方不认识 timeline(只收标准 props)。
import { useEffect, useState, type ComponentType } from "react";
import type { BlockRendererContribution } from "@my-harness-desktop/contract";
import { getPluginComponent, asReactComponent } from "./plugin-modules";
import { useUiStore } from "../../../src/api/renderer/stores/ui-store";

/** blockRenderers 槽查询项:贡献声明 + 来源 pluginId(registry.blockRendererItems 的运行时形态)。 */
export type BlockRendererItem = BlockRendererContribution & { pluginId: string };

let cache: { nonce: number; data: BlockRendererItem[] } | null = null;

/** 查 blockRenderers 槽全部贡献(镜像 useMessageActions:同 nonce 单发,失效重拉)。 */
export function useBlockRenderers(): BlockRendererItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<BlockRendererItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.pi.slots.blockRenderers().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}

/** (block, name?) 二键解析(设计 §3.2):
 *  特化层(names 精确命中,name 小写比较)优先于通用层(未声明 names 的兜底项);
 *  层内 order 小者胜,同 order 取数组后者(items 保注册序,后注册=高优先级 source);
 *  再平手不可能——同插件同 id 贡献在注册时已被 removeById 整项替换。 */
export function resolveBlockRenderer(
  items: BlockRendererItem[],
  block: string,
  name?: string,
): BlockRendererItem | undefined {
  const lower = name?.toLowerCase();
  const hits = (i: BlockRendererItem): boolean =>
    lower !== undefined && (i.names ?? []).some((n) => n.toLowerCase() === lower);
  const specialized = items.filter((i) => i.block === block && hits(i));
  const generic = items.filter((i) => i.block === block && i.names === undefined);
  const pool = specialized.length > 0 ? specialized : generic;
  return pool.reduce<BlockRendererItem | undefined>(
    (best, cur) => ((cur.order ?? 100) <= (best?.order ?? 100) ? cur : best),
    undefined,
  );
}

/** 按贡献项匹配插件 exports 里的组件(§7.4 自动匹配);拿不到视为无此候选,消费方落兜底。 */
export function resolveBlockRendererComponent(item: BlockRendererItem): ComponentType<Record<string, unknown>> | undefined {
  return asReactComponent(getPluginComponent(item.pluginId, item.component)) as ComponentType<Record<string, unknown>> | undefined;
}
