// FileTree —— 目录树部件(react-complex-tree,VSCode 式资源管理器)。
//
// 数据源:window.pi.fs.readDirTree(pluginId, cwd, {maxDepth, ignore})(fs:project 能力,调用方插件需声明)。
// 从 shell/renderer/components/file-tree.tsx 收编为共享部件:插件(file-tree)
// 和壳都可能用,收进 @pi-desktop/react 避免各写一份。
//
// 增量(共享部件不破坏旧调用方):
// - ignore/maxDepth/onOpenFile/refreshKey 可选 props(默认值向后兼容,旧调用方不传也工作)。
// - 数据源从"逐层懒加载 listDir"切换为"一次 readDirTree 拿整树",展开/收起纯前端。
// - 排序收敛:目录在前、各自字母序(所有下游共享的通用 UI 语义,这里收敛一次)。
import { useEffect, useMemo, useState, useCallback } from "react";
import { ControlledTreeEnvironment, Tree, type TreeItem, type TreeItemIndex } from "react-complex-tree";
import { File as FileIcon, Folder, FolderOpen } from "lucide-react";
import "react-complex-tree/lib/style-modern.css";
// 主题 token 映射层:须排在库默认样式之后,同特异性下后加载者覆盖变量定义。
import "./file-tree.css";
import { usePluginId } from "../plugin-id-context";
import type { FileTreeNode } from "@pi-desktop/core";

// ignore 列表是内容(调用方/插件可改),这里给的是所有下游共享的通用默认值。
const DEFAULT_IGNORE = ["node_modules", ".git", "dist", "out", ".next", "coverage", "target"];

// 每个 FileTree 实例自带独立 ControlledTreeEnvironment(局部作用域),同 treeId 不冲突。
const TREE_ID = "file-tree";

interface FileTreeProps {
  cwd: string;
  /** 忽略的目录名集合(传给内核,内核按名跳过不回读)。 */
  ignore?: string[];
  /** 递归限深,默认 4。 */
  maxDepth?: number;
  /** 文件点击回调,默认 window.pi.openFile(系统默认应用打开)。 */
  onOpenFile?: (path: string) => void;
  /** 变化时重新调用 readDirTree(刷新实现,不引入 polling)。 */
  refreshKey?: number;
}

// 排序收敛:目录在前、各自字母序(所有下游共享的通用 UI 语义,这里收敛一次)。
function sortChildren(children: FileTreeNode[] | undefined): FileTreeNode[] {
  if (!children) return [];
  const dirs = children.filter((c) => c.isDir);
  const files = children.filter((c) => !c.isDir);
  const cmp = (a: FileTreeNode, b: FileTreeNode) => a.name.localeCompare(b.name);
  dirs.sort(cmp);
  files.sort(cmp);
  return [...dirs, ...files];
}

// 把 domain FileTreeNode 树递归摊平成 react-complex-tree 的 items 表。
// items[childPath].children 只存直接子项 index;返回直接子项 index 列表。
function flattenChildren(
  node: FileTreeNode,
  path: string,
  items: Record<TreeItemIndex, TreeItem>,
): TreeItemIndex[] {
  const sorted = sortChildren(node.children);
  const childIndexes: TreeItemIndex[] = [];
  for (const child of sorted) {
    const childPath = `${path}/${child.name}`;
    const item: TreeItem = {
      index: childPath,
      isFolder: child.isDir,
      canRename: false,
      canMove: false,
      data: { name: child.name, path: childPath, isDir: child.isDir },
      children: child.isDir ? [] : undefined,
    };
    items[childPath] = item;
    childIndexes.push(childPath);
    if (child.isDir && child.children) {
      // 递归摊平后代,并回填直接子项 index。
      item.children = flattenChildren(child, childPath, items);
    }
  }
  return childIndexes;
}

export function FileTree({
  cwd,
  ignore,
  maxDepth,
  onOpenFile,
  refreshKey,
}: FileTreeProps): React.ReactNode {
  const pluginId = usePluginId();
  const [items, setItems] = useState<Record<TreeItemIndex, TreeItem>>({});
  const [roots, setRoots] = useState<TreeItemIndex[]>([]);
  // 展开态必须组件自持:ControlledTreeEnvironment 的 viewState 是全控的 ——
  // 渲染只读 viewState[treeId].expandedItems(getItemsLinearly / useTreeItemRenderContext),
  // onExpand/onCollapse 只是通知,库不替我们改状态。传常量 viewState={{}} + 空 handler
  // 等于永远折叠:点击目录零反馈,树永远只显示第一层(点不开的根因)。
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>([]);

  const load = useCallback(async () => {
    if (!cwd) {
      setItems({});
      setRoots([]);
      return;
    }
    let tree: FileTreeNode;
    try {
      tree = await window.pi.fs.readDirTree(pluginId, cwd, {
        maxDepth: maxDepth ?? 4,
        ignore: ignore ?? DEFAULT_IGNORE,
      });
    } catch {
      // fs:project 是 fail-closed 的(无激活项目根/越界会拒绝):拒绝语义=空树,
      // 不能放任 unhandled rejection,也不残留上一棵树的陈旧条目。
      setItems({});
      setRoots([]);
      setExpandedItems([]);
      return;
    }
    const items: Record<TreeItemIndex, TreeItem> = {};
    const rootId = cwd;
    items[rootId] = {
      index: rootId,
      isFolder: true,
      canRename: false,
      canMove: false,
      data: { name: tree.name, path: rootId, isDir: true },
      children: [],
    };
    items[rootId].children = flattenChildren(tree, cwd, items);
    setItems(items);
    setRoots([cwd]);
    // 切换项目后清掉不归属当前 cwd 的展开 id;刷新同 cwd 时 id 不变,展开态自然保留。
    setExpandedItems((prev) =>
      prev.filter((i) => typeof i === "string" && i.startsWith(cwd + "/")),
    );
  }, [cwd, pluginId, maxDepth, JSON.stringify(ignore)]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const onPrimaryAction = useCallback((item: TreeItem) => {
    const data = item.data as { path: string; isDir: boolean };
    if (data.isDir) return;
    const open = onOpenFile ?? ((p: string) => void window.pi.openFile(p));
    open(data.path);
  }, [onOpenFile]);

  // 展开态回写:ControlledTreeEnvironment 是全控组件,viewState 是唯一数据源、
  // onExpand/onCollapse 只是通知(库源码:env.expandItem 只转发回调,不反哺 viewState)。
  // 之前这里传 viewState={{}} + 空 handler —— 等于永远折叠,树点不开的根因。
  const onExpandItem = useCallback((item: TreeItem) => {
    setExpandedItems((prev) => (prev.includes(item.index) ? prev : [...prev, item.index]));
  }, []);
  const onCollapseItem = useCallback((item: TreeItem) => {
    setExpandedItems((prev) => prev.filter((i) => i !== item.index));
  }, []);
  const viewState = useMemo(() => ({ [TREE_ID]: { expandedItems } }), [expandedItems]);

  if (!cwd) return null;

  return (
    <ControlledTreeEnvironment
      items={items}
      getItemTitle={(item) => (item.data as { name: string }).name}
      viewState={viewState}
      onExpandItem={onExpandItem}
      onCollapseItem={onCollapseItem}
      onPrimaryAction={(item) => onPrimaryAction(item)}
      renderItemTitle={({ title, item, context }) => (
        <span className={item.isFolder ? "ft-row ft-row-folder" : "ft-row"}>
          {item.isFolder
            ? (context.isExpanded ? <FolderOpen className="ft-icon" /> : <Folder className="ft-icon" />)
            : <FileIcon className="ft-icon" />}
          <span className="ft-name">{title}</span>
        </span>
      )}
      canSearch={false}
      canDragAndDrop={false}
      canReorderItems={false}
    >
      <Tree treeId={TREE_ID} rootItem={String(roots[0] ?? "")} treeLabel="Files" />
    </ControlledTreeEnvironment>
  );
}
