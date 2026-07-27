// 文件树 —— 用 react-complex-tree(VSCode 式资源管理器)。
//
// 替代之前手写的一层 readdirSync + ChatRow。react-complex-tree 提供:
// - 树形展开/折叠(多级,展开时按需拉子目录)
// - 键盘导航(方向键/Enter)
// - WAI-ARIA treeview(无障碍)
// 排序:文件夹在前,各自按名字排(VSCode 默认)。
//
// 数据源:从 main 的 fs:listDir IPC 拉(只拉一层),展开时按需拉子目录。
import { useEffect, useState, useRef, useCallback } from "react";
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
  // 用 ref 存最新 items,避免 onExpand 闭包旧 items(导致展开时查不到 item)
  const itemsRef = useRef(items);
  itemsRef.current = items;

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

  // 展开文件夹时按需拉子目录(用 ref 读最新 items,不依赖 items state)
  const onExpand = useCallback(async (itemId: TreeItemIndex): Promise<void> => {
    const current = itemsRef.current[itemId];
    if (!current?.isFolder) return;
    if (current.children && current.children.length > 0) return;

    const { itemIds, newItems } = await scanDir(itemId as string);
    setItems((prev) => ({
      ...prev,
      ...newItems,
      [itemId]: { ...prev[itemId], children: itemIds },
    }));
  }, [scanDir]);

  return (
    <ControlledTreeEnvironment
      items={items}
      getItemTitle={(item) => (item.data as { name: string }).name}
      viewState={{}}
      onExpandItem={(item) => void onExpand(item.index)}
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
