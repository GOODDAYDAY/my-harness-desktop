// 共享 JSON 深合并 —— application 层。deepmerge 包,数组整替(配置语义:patch 的数组覆盖而非拼接)。
import deepmerge from "deepmerge";

export function deepMergeJson(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return deepmerge(current, patch, { arrayMerge: (_target, source) => source });
}
