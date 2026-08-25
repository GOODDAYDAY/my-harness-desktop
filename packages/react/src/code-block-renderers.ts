// code-block-renderers.ts —— codeBlockRenderers 槽的 renderer 侧机制:查询、按围栏语言解析、组件匹配。
//
// 三段式机制(镜像 block-renderers.ts §3.3):
// ① 声明:贡献者在 plugin.json 写 contributes.codeBlockRenderers(静态 {id, languages, component, order?});
// ② 消费:markdown 文本渲染器/文件预览经 useCodeBlockRenderers() 查槽(pluginsNonce 失效重拉);
// ③ 渲染:resolveCodeBlockRenderer 按语言定贡献项,resolveCodeBlockRendererComponent 匹配插件 exports。
// 分工边界:blockRenderers 管"整块类型"(text/toolCall…),本槽管"文本块内部的围栏语言"(mermaid/puml…)。
import { useEffect, useState, type ComponentType } from "react";
import type { CodeBlockRendererContribution } from "@my-harness-desktop/contract";
import { getPluginComponent, asReactComponent } from "./plugin-modules";
import { useUiStore } from "../../../src/api/renderer/stores/ui-store";

/** codeBlockRenderers 槽查询项:贡献声明 + 来源 pluginId。 */
export type CodeBlockRendererItem = CodeBlockRendererContribution & { pluginId: string };

let cache: { nonce: number; data: CodeBlockRendererItem[] } | null = null;

/** 查 codeBlockRenderers 槽全部贡献(同 nonce 单发,失效重拉)。 */
export function useCodeBlockRenderers(): CodeBlockRendererItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<CodeBlockRendererItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.codeBlockRenderers().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}

/** 按围栏语言解析渲染器(大小写不敏感):命中项按 order 小者胜,同 order 取数组后者
 *  (items 保注册序,后注册 = 高优先级 source——第三方可单语言覆盖内置)。 */
export function resolveCodeBlockRenderer(
  items: CodeBlockRendererItem[],
  language: string,
): CodeBlockRendererItem | undefined {
  const lower = language.toLowerCase();
  const matched = items.filter((i) =>
    (i.languages ?? []).some((l) => l.toLowerCase() === lower),
  );
  return pickBest(matched);
}

/** 按文件扩展名解析渲染器(小写比较,不带点):查贡献项的 fileExtensions 声明,
 *  命中规则与 resolveCodeBlockRenderer 同。文件预览用——图文件按扩展名找到槽中渲染器。 */
export function resolveCodeBlockRendererByExtension(
  items: CodeBlockRendererItem[],
  extension: string,
): CodeBlockRendererItem | undefined {
  const lower = extension.toLowerCase();
  const matched = items.filter((i) =>
    (i.fileExtensions ?? []).some((e) => e.toLowerCase() === lower),
  );
  return pickBest(matched);
}

function pickBest(matched: CodeBlockRendererItem[]): CodeBlockRendererItem | undefined {
  return matched.reduce<CodeBlockRendererItem | undefined>(
    (best, cur) => ((cur.order ?? 100) <= (best?.order ?? 100) ? cur : best),
    undefined,
  );
}

/** 按贡献项匹配插件 exports 里的组件(经 getPluginComponent 自动匹配,§7.4);
 *  拿不到视为无此候选,消费方落兜底(源码呈现)。 */
export function resolveCodeBlockRendererComponent(
  item: CodeBlockRendererItem,
): ComponentType<{ code: string; streaming?: boolean }> | undefined {
  return asReactComponent(getPluginComponent(item.pluginId, item.component)) as ComponentType<{ code: string; streaming?: boolean }> | undefined;
}
