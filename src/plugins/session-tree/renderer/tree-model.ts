// tree-model —— session-tree 插件纯逻辑层(无 React/无 IO,可单测)。
//
// 职责:把投影好的 TreeNode[](已带 entryType/preview/timestamp/label/isLeaf)
// 变成渲染需要的结构:过滤可见性、相对时间、路径查找、分支泳道、单链压缩。
// 渲染层(index.tsx / fullscreen-map.tsx)只消费,不推导。
import type { TreeNode } from "@pi-desktop/react";

/** 节点分组:chat=对话(user/assistant);tool=工具(toolResult/bashExecution/custom/custom_message);
 *  label=标签节点;event=其余结构性事件(compaction/model_change…)。 */
export type TreeGroup = "chat" | "tool" | "event" | "label";

export function groupOf(t?: string): TreeGroup {
  if (!t) return "event";
  if (t === "user" || t === "assistant") return "chat";
  if (t === "toolResult" || t === "bashExecution" || t === "custom" || t === "custom_message") return "tool";
  if (t === "label" || t === "label_reset") return "label";
  return "event";
}

/** 过滤模式(仿底座 TUI /tree 的 Ctrl+O 过滤)。 */
export type TreeFilter = "all" | "noTools" | "userOnly" | "labeled";

/** 节点是否命中过滤模式。 */
export function matchesFilter(n: TreeNode, f: TreeFilter): boolean {
  if (f === "all") return true;
  if (f === "noTools") return n.entryType !== "toolResult" && n.entryType !== "bashExecution";
  if (f === "userOnly") return n.entryType === "user";
  return Boolean(n.label) || n.entryType === "label";
}

/** 收集某节点下所有命中的后代(被滤掉的节点跳过,其后代上提)。 */
export function visibleChildren(n: TreeNode, p: (n: TreeNode) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  for (const c of n.children ?? []) {
    if (p(c)) out.push(c);
    else out.push(...visibleChildren(c, p));
  }
  return out;
}

/** 过滤后的可见森林:命中节点保留,未命中节点的后代上提。 */
export function visibleForest(nodes: TreeNode[], p: (n: TreeNode) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (p(n)) out.push(n);
    else out.push(...visibleChildren(n, p));
  }
  return out;
}

/** 相对时间(Intl.RelativeTimeFormat,零新 i18n 键)。 */
export function relTime(ts: number | undefined, now: number, lang: string): string {
  if (!ts) return "";
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const diffSec = Math.round((ts - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86400), "day");
}

/** 按 entryId 找节点。 */
export function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.entryId === id) return n;
    const hit = findNode(n.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}

/** 找 root→targetId 的路径(含 target);找不到回 null。 */
export function findPath(nodes: TreeNode[], targetId: string): TreeNode[] | null {
  for (const n of nodes) {
    if (n.entryId === targetId) return [n];
    const sub = findPath(n.children ?? [], targetId);
    if (sub) return [n, ...sub];
  }
  return null;
}

/** 计算分支泳道:主泳道=当前叶子路径,副泳道=其他 root→leaf 路径(按末条时间倒序)。 */
export function branchLanes(nodes: TreeNode[], leafId: string | null): { main: TreeNode[]; others: TreeNode[][] } {
  const main = leafId ? (findPath(nodes, leafId) ?? []) : [];
  const others: TreeNode[][] = [];
  const collect = (node: TreeNode, path: TreeNode[]): void => {
    const next = [...path, node];
    const kids = node.children ?? [];
    if (kids.length === 0) {
      if (node.entryId !== leafId) others.push(next);
      return;
    }
    for (const k of kids) collect(k, next);
  };
  for (const n of nodes) collect(n, []);
  others.sort((a, b) => (b[b.length - 1]?.timestamp ?? 0) - (a[a.length - 1]?.timestamp ?? 0));
  return { main, others };
}

/** 去掉与主泳道的最长公共前缀,保留分叉点本身——泳道只画分支独有段。 */
export function uniqueSegment(path: TreeNode[], main: TreeNode[]): TreeNode[] {
  let i = 0;
  while (i < path.length && i < main.length && path[i].entryId === main[i].entryId) i++;
  return path.slice(Math.max(0, i - 1));
}

/** 压缩链元信息:count=合并节点数,types=链上 entryType 序列。 */
export interface RunMeta { count: number; types: string[] }

/** 展示行:普通节点,或压缩链行(run 非空,node 为链头)。 */
export interface DisplayRow {
  node: TreeNode;
  depth: number;
  run?: RunMeta;
  /** 是否有可见子节点(链行为链尾的子节点)——渲染折叠箭头用。 */
  hasKids: boolean;
}

/** 事件链成员判定:纯事件组、无标签、非当前叶子。 */
function chainable(n: TreeNode): boolean {
  return groupOf(n.entryType) === "event" && !n.label && !n.isLeaf;
}

/**
 * 把可见森林拍平成渲染行:单链压缩 + 手动折叠。
 * pred 必须与 visibleForest 用同一个过滤谓词——节点 children 是原数组,
 * walk 时靠 pred 重新取可见子节点,谓词不同会导致过滤模式下子节点重复出现。
 * expandedRuns 中的链头解压成普通节点;collapsed 中的节点不递归子树。
 */
export function compressedRows(
  forest: TreeNode[],
  pred: (n: TreeNode) => boolean,
  expandedRuns?: Set<string>,
  collapsed?: Set<string>,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    if (chainable(node) && !expandedRuns?.has(node.entryId)) {
      // 沿单链向下(可见后代),直到命中非 event 节点/多子节点/叶子
      const run: TreeNode[] = [node];
      let cur = node;
      let kids = visibleChildren(cur, pred);
      while (kids.length === 1 && chainable(kids[0])) {
        cur = kids[0];
        run.push(cur);
        kids = visibleChildren(cur, pred);
      }
      if (run.length >= 2) {
        rows.push({
          node: run[0],
          depth,
          run: { count: run.length, types: run.map((n) => n.entryType ?? "event") },
          hasKids: kids.length > 0,
        });
        if (collapsed?.has(run[0].entryId)) return;
        for (const child of kids) walk(child, depth + 1);
        return;
      }
    }
    const kids = visibleChildren(node, pred);
    rows.push({ node, depth, hasKids: kids.length > 0 });
    if (collapsed?.has(node.entryId)) return;
    for (const child of kids) walk(child, depth + 1);
  };
  for (const root of forest) walk(root, 0);
  return rows;
}
