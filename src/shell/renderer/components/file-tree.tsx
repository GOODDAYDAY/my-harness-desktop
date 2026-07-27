// 文件树 —— 用 react-complex-tree(VSCode 式资源管理器)。
//
// 替代之前手写的一层 readdirSync + ChatRow。react-complex-tree 提供:
// - 树形展开/折叠(多级)
// - 键盘导航(方向键/Enter)
// - WAI-ARIA treeview(无障碍)
// - 可搜索过滤
// 排序:文件夹在前,各自按名字排(VSCode 默认)。
//
// 数据源:从 main 的 fs:listDir IPC 拉(只拉一层),展开时按需拉子目录。
import { useEffect, useState, useCallback } from "react";
import { ControlledTreeEnvironment, Tree, type TreeItem, type TreeItemIndex } from "react-complex-tree";
import { usePiApi } from "@pi-desktop/react";
import "react-complex-tree/lib/style-modern.css";

interface DirEntry {
  name: string;
  isDir: boolean;
}

export function FileTree({ cwd }: { cwd: string }): React.ReactNode {
  const pi = usePiApi();
  const [items, setItems] = useState<Record<TreeItemIndex, TreeItem>>({});
  const [roots, setRoots] = useState<TreeItemIndex[]>([]);

  // 扫一层目录 → 返回 TreeItem children + items
  const scanDir = useCallback(async (dir: string): Promise<{ itemIds: TreeItemIndex[]; newItems: Record<string, TreeItem> }> => {
    const entries = (await pi.fs.listDir(dir)) as DirEntry[];
    const newItems: Record<string, TreeItem> = {};
    const itemIds: TreeItemIndex[] = [];

    for (const entry of entries) {
      const itemId = `${dir}/${entry.name}`;
      itemIds.push(itemId);
      newItems[itemId] = {
        index: itemId,
        isFolder: entry.isDir,
        canRename: false,
        canMove: false,
        data: { name: entry.name, path: itemId, isDir: entry.isDir },
        // 文件夹初始不展开(children 等 onExpand 时拉)
        children: entry.isDir ? [] : undefined,
      };
    }

    return { itemIds, newItems };
  }, [pi]);

  // 启动:扫 cwd 一层
  useEffect(() => {
    if (!cwd) {
      setItems({});
      setRoots([]);
      return;
    }
    void scanDir(cwd).then(({ itemIds, newItems }) => {
      // 根 item(代表 cwd 本身)
      const rootId = cwd;
      setItems({
        [rootId]: {
          index: rootId,
          isFolder: true,
          canRename: false,
          canMove: false,
          data: { name: cwd.split("/").pop() ?? cwd, path: cwd, isDir: true },
          children: itemIds,
        },
        ...newItems,
      });
      setRoots([rootId]);
    });
  }, [cwd, scanDir]);

  // 展开文件夹时按需拉子目录
  const onExpand = useCallback(async (itemId: string): Promise<void> => {
    const item = items[itemId];
    if (!item?.isFolder) return;
    // 已有 children 且不为空 → 已拉过
    if (item.children && item.children.length > 0) return;

    const { itemIds, newItems } = await scanDir(itemId);
    setItems((prev) => ({
      ...prev,
      ...newItems,
      [itemId]: { ...prev[itemId], children: itemIds },
    }));
  }, [items, scanDir]);

  return (
    <ControlledTreeEnvironment
      items={items}
      getItemTitle={(item) => (item.data as { name: string }).name}
      viewState={{}}
      onExpandItem={(item) => void onExpand(item.index as string)}
      onCollapseItem={() => {}}
      onPrimaryAction={() => {}}
      canSearch={false}
      canDragAndDrop={false}
      canReorderItems={false}
    >
      <Tree treeId="file-tree" rootItem={roots[0] ?? ""} treeLabel="Files" />
    </ControlledTreeEnvironment>
  );
}
