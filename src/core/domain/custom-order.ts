/** 自定义顺序归位:不在 order 里的按 created 降序在前(新项置顶),order 里的过滤失效 key 后接在后。
 *  拖拽排序插件共用的唯一实现(sessions-list/session-bookmarks 等),勿再各写一份。 */
export function applyCustomOrder<T>(
  items: T[],
  order: string[] | undefined,
  getKey: (item: T) => string,
  getCreated: (item: T) => string,
): T[] {
  if (!order || order.length === 0) return items;
  const orderSet = new Set(order);
  const inOrder: T[] = [];
  const rest: T[] = [];
  for (const item of items) (orderSet.has(getKey(item)) ? inOrder : rest).push(item);
  rest.sort((a, b) => getCreated(b).localeCompare(getCreated(a)));
  const byKey = new Map(inOrder.map((item) => [getKey(item), item]));
  const ordered = order
    .map((k) => byKey.get(k))
    .filter((item): item is T => item !== undefined);
  return [...rest, ...ordered];
}
