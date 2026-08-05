// FileTree —— 目录树部件(react-complex-tree,VSCode 式资源管理器)。
//
// 数据源:window.pi.fs.readDirTree(pluginId, cwd, {maxDepth, ignore})(fs:project 能力,调用方插件需声明)。
// 从 shell/renderer/components/file-tree.tsx 收编为共享部件:插件(file-tree)
// 和壳都可能用,收进 @pi-desktop/react 避免各写一份。
//
// 能力全景(VSCode Explorer 对齐):
// - 右键菜单(radix CtxMenu 共享部件):新建文件/文件夹、剪切/复制/粘贴、
//   复制路径/相对路径、在 Finder 中显示、重命名、删除(内联二次确认)。
// - 变更 IPC 走 window.pi.fs.*(fs:project 门控 + 项目根圈禁),完成后重拉树——
//   IPC resolve 即事件,不轮询不 sleep;展开态跨重拉保留。
// - 深度懒加载:首屏 walk 限深(默认 4),边界目录 children 缺席打 deferred 标记,
//   展开时以该目录为根再 walk 一跳(ensureChildren),任意深度可达;刷新后链式补拉。
// - 重命名/新建统一走库自带 rename(F2 / startRenamingItem / onRenameItem / onAbortRenamingItem):
//   新建 = 插临时节点 + 程序化 rename,abort 清临时节点,confirm 落 IPC(收敛成熟包,不手滚 input)。
// - 剪贴板是部件内部状态:cut 源行半透明显示(VSCode 同款),paste 冲突由内核拒绝并上浮错误条。
// - fileActions 槽消费:菜单末段渲染插件贡献的动作(盲审等),invokeFileAction 路由触发。
// - fileIcons 槽消费:行图标按 文件名/扩展名 查槽解析(useFileIconIndex + resolveFileIcon),
//   内置批次由 file-tree 插件 manifest 贡献,第三方插件可同槽覆盖;未命中回退通用文件图标。
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { ControlledTreeEnvironment, Tree, type TreeItem, type TreeItemIndex, type TreeRef } from "react-complex-tree";
import {
  File as FileIcon, Folder, FolderOpen, FilePlus, FolderPlus, Scissors, Copy, Clipboard,
  Link, Link2, ExternalLink, Pencil, Trash2, Check, X,
} from "lucide-react";
import clsx from "clsx";
import "react-complex-tree/lib/style-modern.css";
// 主题 token 映射层:须排在库默认样式之后,同特异性下后加载者覆盖变量定义。
import "./file-tree.css";
import { useTranslation } from "react-i18next";
import { usePluginId } from "../plugin-id-context";
import { CtxMenu, CtxMenuItem, CtxMenuSeparator } from "./context-menu";
import { PluginIcon, resolvePluginIcon } from "./plugin-icon";
import { useFileActions, invokeFileAction } from "../file-actions";
import { useFileIconIndex } from "../file-icons";
import { resolveFileIcon } from "@pi-desktop/contract";
import type { FileTreeNode } from "@pi-desktop/contract";

// ignore 列表是内容(调用方/插件可改),这里给的是所有下游共享的通用默认值。
const DEFAULT_IGNORE = ["node_modules", ".git", "dist", "out", ".next", "coverage", "target"];

// 每个 FileTree 实例自带独立 ControlledTreeEnvironment(局部作用域),同 treeId 不冲突。
const TREE_ID = "file-tree";

// 与库默认 renderDepthOffset 一致(useRenderers: renderDepthOffset ?? 10),自绘 renderItem 需复刻缩进。
const DEPTH_OFFSET = 10;

interface RowData {
  name: string;
  path: string;
  isDir: boolean;
  /** 新建中的临时节点:"file"|"dir";真实节点无此字段。 */
  temp?: "file" | "dir";
  /** 限深边界目录:子树未随首屏下钻(children 缺席),展开时懒加载。 */
  deferred?: boolean;
}

interface FileTreeProps {
  cwd: string;
  /** 忽略的目录名集合(传给内核,内核按名跳过不回读)。 */
  ignore?: string[];
  /** 首屏递归限深,默认 4;边界目录展开时懒加载,不影响可达深度。 */
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
// 目录的 children 缺席(限深边界/读失败)打 deferred 标记——展开时经 ensureChildren 按需下钻,
// 与空目录(children: [])区分开:空目录展开就是空,deferred 目录展开先拉子树。
function flattenChildren(
  node: FileTreeNode,
  path: string,
  items: Record<TreeItemIndex, TreeItem>,
): TreeItemIndex[] {
  const sorted = sortChildren(node.children);
  const childIndexes: TreeItemIndex[] = [];
  for (const child of sorted) {
    const childPath = `${path}/${child.name}`;
    const deferred = child.isDir && child.children === undefined;
    const item: TreeItem = {
      index: childPath,
      isFolder: child.isDir,
      canRename: true,
      canMove: false,
      data: { name: child.name, path: childPath, isDir: child.isDir, ...(deferred ? { deferred: true } : {}) } satisfies RowData,
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

/** 收集一棵子树里所有 deferred 目录的路径(刷新后链式补拉用:展开态保留的深层目录逐个下钻)。 */
function collectDeferredPaths(node: FileTreeNode, path: string, out: string[]): string[] {
  for (const child of node.children ?? []) {
    if (!child.isDir) continue;
    const childPath = `${path}/${child.name}`;
    if (child.children === undefined) out.push(childPath);
    else collectDeferredPaths(child, childPath, out);
  }
  return out;
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

export function FileTree({
  cwd,
  ignore,
  maxDepth,
  onOpenFile,
  refreshKey,
}: FileTreeProps): React.ReactNode {
  const pluginId = usePluginId();
  const { t } = useTranslation();
  const [items, setItems] = useState<Record<TreeItemIndex, TreeItem>>({});
  const [roots, setRoots] = useState<TreeItemIndex[]>([]);
  // 展开态必须组件自持:ControlledTreeEnvironment 的 viewState 是全控的 ——
  // 渲染只读 viewState[treeId].expandedItems(getItemsLinearly / useTreeItemRenderContext),
  // onExpand/onCollapse 只是通知,库不替我们改状态。传常量 viewState={{}} + 空 handler
  // 等于永远折叠:点击目录零反馈,树永远只显示第一层(点不开的根因)。
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>([]);
  const [focusedIndex, setFocusedIndex] = useState<TreeItemIndex | null>(null);
  const [clipboard, setClipboard] = useState<{ op: "cut" | "copy"; path: string; isDir: boolean } | null>(null);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const treeRef = useRef<TreeRef>(null);
  const fileActions = useFileActions();
  const fileIconIndex = useFileIconIndex();
  // expandedItems 的 ref 镜像:load/ensureChildren 是不把 expandedItems 列进依赖的闭包,
  // 刷新后链式补拉要读"此刻哪些目录展开着",只能经 ref 取(load 的重跑触发源是 cwd/refreshKey,
  // 若把 expandedItems 列进依赖,每次展开都会整树重拉——事件驱动变拉取式,不行)。
  const expandedRef = useRef<TreeItemIndex[]>([]);
  const inflightRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    expandedRef.current = expandedItems;
  }, [expandedItems]);

  // 懒加载统一入口:展开 deferred 目录时按需下钻(readDirTree 以该目录为根再走一遍限深,
  // 任意深度都可达);失败保 deferred 标记,折叠再展开即重试。inflight 去重防连点并发。
  const ensureChildren = useCallback(async (dirPath: string) => {
    if (inflightRef.current.has(dirPath)) return;
    inflightRef.current.add(dirPath);
    let subtree: FileTreeNode;
    try {
      subtree = await window.pi.fs.readDirTree(pluginId, dirPath, {
        maxDepth: maxDepth ?? 4,
        ignore: ignore ?? DEFAULT_IGNORE,
      });
    } catch (e) {
      inflightRef.current.delete(dirPath);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      return;
    }
    inflightRef.current.delete(dirPath);
    setItems((prev) => {
      const parent = prev[dirPath];
      if (!parent) return prev;
      const next = { ...prev };
      const data = { ...(parent.data as RowData) };
      delete data.deferred;
      next[dirPath] = { ...parent, data, children: [] };
      next[dirPath].children = flattenChildren(subtree, dirPath, next);
      return next;
    });
    // 链式补拉:刷新重建 items 后,深层已展开目录在新树里又是 deferred——逐个下钻恢复。
    // 首次展开无此情况(expandedRef 只含已加载路径),inflight 保证不重复发。
    for (const p of collectDeferredPaths(subtree, dirPath, [])) {
      if (expandedRef.current.includes(p)) void ensureChildren(p);
    }
  }, [pluginId, maxDepth, JSON.stringify(ignore)]);

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
      data: { name: tree.name, path: rootId, isDir: true } satisfies RowData,
      children: [],
    };
    items[rootId].children = flattenChildren(tree, cwd, items);
    setItems(items);
    setRoots([cwd]);
    setConfirmDeletePath(null);
    // 切换项目后清掉不归属当前 cwd 的展开 id;刷新同 cwd 时 id 不变,展开态自然保留。
    setExpandedItems((prev) =>
      prev.filter((i) => typeof i === "string" && i.startsWith(cwd + "/")),
    );
    // 刷新后补拉:仍展开的限深边界目录在新树里回到 deferred,链式下钻恢复其内容。
    for (const p of collectDeferredPaths(tree, cwd, [])) {
      if (expandedRef.current.includes(p)) void ensureChildren(p);
    }
  }, [cwd, pluginId, maxDepth, JSON.stringify(ignore), ensureChildren]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // 变更统一入口:先执行 IPC,成功后保父目录展开并重拉;失败上浮错误条(冲突/越权都走这)。
  const runMutation = useCallback(async (fn: () => Promise<void>, expandPath?: string) => {
    setErrorMsg(null);
    try {
      await fn();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      return;
    }
    if (expandPath) {
      setExpandedItems((prev) => (prev.includes(expandPath) ? prev : [...prev, expandPath]));
    }
    await load();
  }, [load]);

  // 新建 = 插临时节点 + 程序化 rename:onRenameItem 落 IPC,onAbortRenamingItem 清节点。
  const startNewEntry = useCallback((parentPath: string, kind: "file" | "dir") => {
    const tempIndex = `${parentPath}/.__new__`;
    setItems((prev) => {
      const parent = prev[parentPath];
      if (!parent) return prev;
      const temp: TreeItem = {
        index: tempIndex,
        isFolder: kind === "dir",
        canRename: true,
        canMove: false,
        data: { name: "", path: tempIndex, isDir: kind === "dir", temp: kind } satisfies RowData,
      };
      return { ...prev, [tempIndex]: temp, [parentPath]: { ...parent, children: [tempIndex, ...(parent.children ?? [])] } };
    });
    setExpandedItems((prev) => (prev.includes(parentPath) ? prev : [...prev, parentPath]));
    treeRef.current?.startRenamingItem(tempIndex);
  }, []);

  const removeTempEntry = useCallback((tempIndex: string, parentPath: string) => {
    setItems((prev) => {
      if (!prev[tempIndex]) return prev;
      const parent = prev[parentPath];
      const next = { ...prev };
      delete next[tempIndex];
      if (parent) {
        next[parentPath] = { ...parent, children: (parent.children ?? []).filter((c) => c !== tempIndex) };
      }
      return next;
    });
  }, []);

  const onRenameItem = useCallback((item: TreeItem, name: string) => {
    const data = item.data as RowData;
    const newName = name.trim();
    if (data.temp) {
      const parentPath = parentOf(String(item.index));
      const kind = data.temp;
      removeTempEntry(String(item.index), parentPath);
      if (!newName || newName.includes("/") || newName === "." || newName === "..") return;
      const target = `${parentPath}/${newName}`;
      void runMutation(
        () => (kind === "dir" ? window.pi.fs.createDir(pluginId, target) : window.pi.fs.createFile(pluginId, target)),
        parentPath,
      );
      return;
    }
    if (!newName || newName === data.name || newName.includes("/")) return;
    void runMutation(() => window.pi.fs.renamePath(pluginId, data.path, `${parentOf(data.path)}/${newName}`), parentOf(data.path));
  }, [pluginId, removeTempEntry, runMutation]);

  const onAbortRenamingItem = useCallback((item: TreeItem) => {
    const data = item.data as RowData;
    if (data.temp) removeTempEntry(String(item.index), parentOf(String(item.index)));
  }, [removeTempEntry]);

  const requestDelete = useCallback((path: string) => setConfirmDeletePath(path), []);
  const confirmDelete = useCallback(() => {
    const path = confirmDeletePath;
    setConfirmDeletePath(null);
    if (!path) return;
    if (clipboard?.path === path) setClipboard(null);
    void runMutation(() => window.pi.fs.removePath(pluginId, path), parentOf(path));
  }, [confirmDeletePath, clipboard, pluginId, runMutation]);

  const paste = useCallback((targetDir: string) => {
    if (!clipboard) return;
    const name = clipboard.path.split("/").pop() ?? "";
    const dest = `${targetDir}/${name}`;
    if (dest === clipboard.path) return;
    const src = clipboard;
    // 剪切粘贴是一次性消费:先清剪贴板再落 IPC,失败也不重复粘贴
    if (src.op === "cut") setClipboard(null);
    void runMutation(
      () => (src.op === "cut" ? window.pi.fs.renamePath(pluginId, src.path, dest) : window.pi.fs.copyPath(pluginId, src.path, dest)),
      targetDir,
    );
  }, [clipboard, pluginId, runMutation]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 库 rename input 等输入态不拦截(输入框内 Delete/Cmd 键是编辑语义)
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const focused = focusedIndex ? items[focusedIndex] : null;
    const data = focused?.data as RowData | undefined;
    if (!data || data.temp) return;
    if (e.key === "Delete") {
      if (data.path !== cwd) {
        e.preventDefault();
        requestDelete(data.path);
      }
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === "c") {
      e.preventDefault();
      setClipboard({ op: "copy", path: data.path, isDir: data.isDir });
    } else if (key === "x" && data.path !== cwd) {
      e.preventDefault();
      setClipboard({ op: "cut", path: data.path, isDir: data.isDir });
    } else if (key === "v") {
      e.preventDefault();
      paste(data.isDir ? data.path : parentOf(data.path));
    }
  }, [focusedIndex, items, cwd, paste, requestDelete]);

  const onPrimaryAction = useCallback((item: TreeItem) => {
    const data = item.data as RowData;
    if (data.isDir || data.temp) return;
    const open = onOpenFile ?? ((p: string) => void window.pi.openFile(p));
    open(data.path);
  }, [onOpenFile]);

  // 展开态回写:ControlledTreeEnvironment 是全控组件,viewState 是唯一数据源、
  // onExpand/onCollapse 只是通知(库源码:env.expandItem 只转发回调,不反哺 viewState)。
  // 之前这里传 viewState={{}} + 空 handler —— 等于永远折叠,树点不开的根因。
  const onExpandItem = useCallback((item: TreeItem) => {
    setExpandedItems((prev) => (prev.includes(item.index) ? prev : [...prev, item.index]));
    if ((item.data as RowData).deferred) void ensureChildren(String(item.index));
  }, [ensureChildren]);
  const onCollapseItem = useCallback((item: TreeItem) => {
    setExpandedItems((prev) => prev.filter((i) => i !== item.index));
  }, []);
  const viewState = useMemo(() => ({ [TREE_ID]: { expandedItems } }), [expandedItems]);

  const copyText = useCallback((text: string) => void navigator.clipboard.writeText(text), []);
  const relativeOf = useCallback((path: string) => (path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path), [cwd]);

  if (!cwd) return null;

  return (
    <div className="ft-host" onKeyDown={onKeyDown}>
      {errorMsg && (
        <div className="ft-error">
          <span className="ft-error-text">{errorMsg}</span>
          <button type="button" className="ft-error-close" onClick={() => setErrorMsg(null)} title={t("common.close")}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <ControlledTreeEnvironment
        items={items}
        getItemTitle={(item) => (item.data as RowData).name}
        viewState={viewState}
        canRename={true}
        onExpandItem={onExpandItem}
        onCollapseItem={onCollapseItem}
        onFocusItem={(item) => setFocusedIndex(item.index)}
        onPrimaryAction={(item) => onPrimaryAction(item)}
        onRenameItem={(item, name) => onRenameItem(item, name)}
        onAbortRenamingItem={(item) => onAbortRenamingItem(item)}
        renderItem={({ item, depth, children, title, context, arrow }) => {
          const data = item.data as RowData;
          const InteractiveComponent = (context.isRenaming ? "div" : "button") as "button";
          const isCutSource = clipboard?.op === "cut" && clipboard.path === data.path;
          const row = (
            <li
              {...context.itemContainerWithChildrenProps}
              className={clsx(
                "rct-tree-item-li",
                item.isFolder && "rct-tree-item-li-isFolder",
                context.isSelected && "rct-tree-item-li-selected",
                context.isExpanded && "rct-tree-item-li-expanded",
                context.isFocused && "rct-tree-item-li-focused",
              )}
            >
              <div
                {...context.itemContainerWithoutChildrenProps}
                style={{ "--depthOffset": `${(depth + 1) * DEPTH_OFFSET}px` } as React.CSSProperties}
                className={clsx(
                  "rct-tree-item-title-container",
                  item.isFolder && "rct-tree-item-title-container-isFolder",
                  context.isSelected && "rct-tree-item-title-container-selected",
                  context.isExpanded && "rct-tree-item-title-container-expanded",
                  context.isFocused && "rct-tree-item-title-container-focused",
                )}
              >
                {arrow}
                <InteractiveComponent
                  {...context.interactiveElementProps}
                  type={context.isRenaming ? undefined : ("button" as const)}
                  className={clsx(
                    "rct-tree-item-button",
                    item.isFolder && "rct-tree-item-button-isFolder",
                    context.isSelected && "rct-tree-item-button-selected",
                    context.isExpanded && "rct-tree-item-button-expanded",
                    context.isFocused && "rct-tree-item-button-focused",
                  )}
                  style={isCutSource ? { opacity: 0.5 } : undefined}
                >
                  {title}
                </InteractiveComponent>
              </div>
              {children}
            </li>
          );
          if (data.temp) return row;
          const isRoot = data.path === cwd;
          const contributed = fileActions.filter((a) => {
            const target = a.when?.target ?? "both";
            return data.isDir ? target !== "file" : target !== "dir";
          });
          return (
            <CtxMenu trigger={row}>
              {data.isDir && (
                <>
                  <CtxMenuItem icon={<FilePlus className="size-3.5" />} onSelect={() => startNewEntry(data.path, "file")}>
                    {t("files.newFile")}
                  </CtxMenuItem>
                  <CtxMenuItem icon={<FolderPlus className="size-3.5" />} onSelect={() => startNewEntry(data.path, "dir")}>
                    {t("files.newFolder")}
                  </CtxMenuItem>
                  <CtxMenuSeparator />
                </>
              )}
              {!isRoot && (
                <CtxMenuItem icon={<Scissors className="size-3.5" />} onSelect={() => setClipboard({ op: "cut", path: data.path, isDir: data.isDir })}>
                  {t("files.cut")}
                </CtxMenuItem>
              )}
              <CtxMenuItem icon={<Copy className="size-3.5" />} onSelect={() => setClipboard({ op: "copy", path: data.path, isDir: data.isDir })}>
                {t("files.copy")}
              </CtxMenuItem>
              {data.isDir && (
                <CtxMenuItem icon={<Clipboard className="size-3.5" />} disabled={!clipboard} onSelect={() => paste(data.path)}>
                  {t("files.paste")}
                </CtxMenuItem>
              )}
              <CtxMenuSeparator />
              <CtxMenuItem icon={<Link className="size-3.5" />} onSelect={() => copyText(data.path)}>
                {t("files.copyPath")}
              </CtxMenuItem>
              <CtxMenuItem icon={<Link2 className="size-3.5" />} onSelect={() => copyText(relativeOf(data.path))}>
                {t("files.copyRelativePath")}
              </CtxMenuItem>
              <CtxMenuItem icon={<ExternalLink className="size-3.5" />} onSelect={() => void window.pi.revealPath(data.path)}>
                {t("files.revealInFinder")}
              </CtxMenuItem>
              {!isRoot && <CtxMenuSeparator />}
              {!isRoot && (
                <CtxMenuItem icon={<Pencil className="size-3.5" />} onSelect={() => treeRef.current?.startRenamingItem(item.index)}>
                  {t("files.rename")}
                </CtxMenuItem>
              )}
              {!isRoot && (
                <CtxMenuItem danger icon={<Trash2 className="size-3.5" />} onSelect={() => requestDelete(data.path)}>
                  {t("files.delete")}
                </CtxMenuItem>
              )}
              {contributed.length > 0 && <CtxMenuSeparator />}
              {contributed.map((a) => (
                <CtxMenuItem
                  key={`${a.pluginId}:${a.id}`}
                  icon={a.icon ? <PluginIcon name={a.icon} className="size-3.5" /> : undefined}
                  onSelect={() => invokeFileAction(pluginId, a, { path: data.path, isDir: data.isDir, cwd })}
                >
                  {t(a.labelKey)}
                </CtxMenuItem>
              ))}
            </CtxMenu>
          );
        }}
        renderItemTitle={({ title, item, context }) => {
          const data = item.data as RowData;
          if (!data.temp && data.path === confirmDeletePath) {
            return (
              <span className="ft-row ft-confirm-delete">
                <Trash2 className="ft-icon" />
                <span className="ft-name">{t("files.deleteConfirm")}</span>
                <button type="button" className="ft-confirm-btn" title={t("common.confirm")} onClick={(e) => { e.stopPropagation(); confirmDelete(); }}>
                  <Check className="size-3.5" />
                </button>
                <button type="button" className="ft-confirm-btn" title={t("common.cancel")} onClick={(e) => { e.stopPropagation(); setConfirmDeletePath(null); }}>
                  <X className="size-3.5" />
                </button>
              </span>
            );
          }
          if (item.isFolder) {
            return (
              <span className="ft-row ft-row-folder">
                {context.isExpanded ? <FolderOpen className="ft-icon" /> : <Folder className="ft-icon" />}
                <span className="ft-name">{title}</span>
              </span>
            );
          }
          const hit = resolveFileIcon(fileIconIndex, data.name);
          const RowIcon = (hit ? resolvePluginIcon(hit.icon) : null) ?? FileIcon;
          return (
            <span className="ft-row">
              <RowIcon className="ft-icon" style={hit?.color ? { color: hit.color } : undefined} />
              <span className="ft-name">{title}</span>
            </span>
          );
        }}
        canSearch={false}
        canDragAndDrop={false}
        canReorderItems={false}
      >
        <Tree ref={treeRef} treeId={TREE_ID} rootItem={String(roots[0] ?? "")} treeLabel="Files" />
      </ControlledTreeEnvironment>
    </div>
  );
}
