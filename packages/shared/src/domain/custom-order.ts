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
  // ⚠ 必须**按 key 去重**再映射。`byKey` 是 Map（键天然唯一），但 `order.map(k => byKey.get(k))`
  //   是按 `order` 的每一项映射的——`order` 里若有重复 key，同一个 item 就会被取出多次，
  //   于是列表里**同一个会话渲染两行**（实测：items=[a,b]、order=["a","a","b"] → [a,a,b]）。
  //   生产可达：`customOrder` 落在用户可编辑的 JSON 里
  //   （`<cwd>/.my-harness-desktop/config/sessions-list.json`），手改或文件损坏就会带重复项。
  //   这属"损坏域韧性"：坏输入不该让 UI 出现重复行，也不该抛错。
  const emitted = new Set<string>();
  const ordered: T[] = [];
  for (const k of order) {
    if (emitted.has(k)) continue;
    emitted.add(k);
    const item = byKey.get(k);
    if (item !== undefined) ordered.push(item);
  }
  return [...rest, ...ordered];
}
