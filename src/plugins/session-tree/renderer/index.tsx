// session-tree 插件 renderer —— 右面板 Tree 页签:当前会话的分支树。
//
// 数据:ctx.sessions.getSnapshot().tree(核心会话能力)。nonce/事件驱动刷新。
import { useEffect, useMemo, useState } from "react";
import { ListTree, RefreshCw } from "lucide-react";
import { ControlledTreeEnvironment, Tree, type TreeItem, type TreeItemIndex } from "react-complex-tree";
import { registerSidePanelComponent, usePluginContext, useUiStore, EmptyState, type TreeNode } from "@pi-desktop/react";
import "react-complex-tree/lib/style-modern.css";

const PLUGIN_ID = "session-tree";
registerSidePanelComponent("SessionTreeTab", SessionTreeTab);

/** 会话树节点 → react-complex-tree 的扁平 items(合成 root)。 */
function buildItems(nodes: TreeNode[]): Record<TreeItemIndex, TreeItem> {
  const items: Record<TreeItemIndex, TreeItem> = {
    __root__: { index: "__root__", isFolder: true, data: { name: "会话树" }, children: [] },
  };
  const walk = (node: TreeNode, parentId: string): void => {
    if (!node.entryId) return; // 防御:底座/映射给的节点缺锚时跳过,不渲染
    const childIds = (node.children ?? []).map((c) => c.entryId).filter(Boolean);
    items[node.entryId] = {
      index: node.entryId,
      isFolder: childIds.length > 0,
      canRename: false,
      canMove: false,
      data: { name: node.label ?? node.entryId.slice(0, 8) },
      children: childIds,
    };
    (items[parentId].children as string[]).push(node.entryId);
    for (const c of node.children ?? []) walk(c, node.entryId);
  };
  for (const n of nodes) walk(n, "__root__");
  return items;
}

function SessionTreeTab(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const { currentCwd, sessionNonce } = useUiStore();
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [failed, setFailed] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      const snap = await ctx.sessions.getSnapshot();
      setNodes(snap.tree ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => {
    if (currentCwd) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd, sessionNonce]);

  const items = useMemo(() => buildItems(nodes), [nodes]);

  if (!currentCwd) return <EmptyState icon={<ListTree className="size-8" />} title="先打开文件夹" />;
  if (failed || nodes.length === 0) {
    return <EmptyState icon={<ListTree className="size-8" />} title="暂无会话树" description="发消息后开始形成分支" />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex justify-end px-2 pt-1 shrink-0">
        <button onClick={() => void refresh()} title="刷新" style={refreshBtnStyle}>
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        <ControlledTreeEnvironment
          items={items}
          getItemTitle={(item) => (item.data as { name: string }).name}
          viewState={{}}
          canSearch={false}
          canDragAndDrop={false}
          canReorderItems={false}
        >
          <Tree treeId="session-tree" rootItem="__root__" treeLabel="会话树" />
        </ControlledTreeEnvironment>
      </div>
    </div>
  );
}

const refreshBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "24px", height: "24px", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)", background: "transparent",
  color: "var(--color-muted)", cursor: "pointer",
};
