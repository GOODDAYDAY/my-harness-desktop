// tree-model —— session-tree 插件纯逻辑层(无 React/无 IO,可单测)。
//
// 职责:把投影好的 TreeNode[](已带 entryType/preview/timestamp/label/isLeaf)
// 变成渲染需要的结构:过滤可见性、相对时间、路径查找、分支泳道、单链压缩、分叉点缩进。
// 渲染层(index.tsx / fullscreen-map.tsx)只消费,不推导。
import type { TreeNode } from "@my-harness-desktop/react";

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

/** 过滤模式(仿内核 TUI /tree 的 Ctrl+O 过滤)。 */
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
  /** 分出的旁支数(可见子节点-1);>0 时渲染分叉弧线与徽章。 */
  forkKids: number;
  /** 铁轨延续:cont[d]=本行下方深度 d 的泳道线是否延续(d 取 0..depth)。 */
  cont: boolean[];
}

/** 事件链成员判定:纯事件组、无标签、非当前叶子。 */
function chainable(n: TreeNode): boolean {
  return groupOf(n.entryType) === "event" && !n.label && !n.isLeaf;
}

/**
 * 把可见森林拍平成渲染行:单链压缩 + 手动折叠 + git-graph 泳道。
 * pred 必须与 visibleForest 用同一个过滤谓词——节点 children 是原数组,
 * walk 时靠 pred 重新取可见子节点,谓词不同会导致过滤模式下子节点重复出现。
 * expandedRuns 中的链头解压成普通节点;collapsed 中的节点不递归子树。
 * 泳道模型:多子时"脊柱孩子"(含当前叶子的子树,否则子树最新者)同深度延续泳道,
 * 旁支 depth+1 且先走——分支块紧贴分叉点,主干/长支不再一路右缩。
 * cont 由倒扫得出:nextAt[d] 记下方最近的深度 d 行,被更浅行截断即失效。
 */
export function compressedRows(
  forest: TreeNode[],
  pred: (n: TreeNode) => boolean,
  leafId?: string | null,
  expandedRuns?: Set<string>,
  collapsed?: Set<string>,
): DisplayRow[] {
  const subMax = new Map<string, number>();
  const hasLeaf = new Map<string, boolean>();
  const prescan = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      prescan(n.children ?? []);
      let mx = n.timestamp ?? 0;
      let hl = n.entryId === leafId;
      for (const c of n.children ?? []) {
        mx = Math.max(mx, subMax.get(c.entryId) ?? 0);
        hl = hl || (hasLeaf.get(c.entryId) ?? false);
      }
      subMax.set(n.entryId, mx);
      hasLeaf.set(n.entryId, hl);
    }
  };
  prescan(forest);
  const spineOf = (kids: TreeNode[]): TreeNode =>
    kids.find((k) => hasLeaf.get(k.entryId)) ??
    kids.reduce((a, b) => ((subMax.get(a.entryId) ?? 0) >= (subMax.get(b.entryId) ?? 0) ? a : b));

  const rows: DisplayRow[] = [];
  const walkKids = (kids: TreeNode[], depth: number): void => {
    if (kids.length === 0) return;
    const spine = spineOf(kids);
    for (const b of kids) if (b !== spine) walk(b, depth + 1);
    walk(spine, depth);
  };
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
          forkKids: Math.max(0, kids.length - 1),
          cont: [],
        });
        if (collapsed?.has(run[0].entryId)) return;
        walkKids(kids, depth);
        return;
      }
    }
    const kids = visibleChildren(node, pred);
    rows.push({ node, depth, hasKids: kids.length > 0, forkKids: Math.max(0, kids.length - 1), cont: [] });
    if (collapsed?.has(node.entryId)) return;
    walkKids(kids, depth);
  };
  for (const root of forest) walk(root, 0);
  const nextAt: (number | undefined)[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const d0 = rows[i].depth;
    for (let d = nextAt.length - 1; d > d0; d--) nextAt[d] = undefined;
    const cont: boolean[] = [];
    for (let d = 0; d <= d0; d++) cont[d] = nextAt[d] !== undefined;
    rows[i].cont = cont;
    nextAt[d0] = i;
  }
  return rows;
}
