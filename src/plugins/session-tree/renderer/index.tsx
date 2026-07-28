// session-tree 插件 renderer —— 右面板 Tree 页签:当前会话的分支树。
//
// 数据读 session-store 投影的 tree(不拉取);刷新按钮走 sessions.sync 强制重拉。
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ListTree, RefreshCw, Bookmark } from "lucide-react";
import { ControlledTreeEnvironment, Tree, type TreeItem, type TreeItemIndex } from "react-complex-tree";
import { registerSidePanelComponent, usePluginContext, useUiStore, useSessionStore, EmptyState, type TreeNode } from "@pi-desktop/react";
import "react-complex-tree/lib/style-modern.css";

const PLUGIN_ID = "session-tree";
registerSidePanelComponent("SessionTreeTab", SessionTreeTab);

/** 会话树节点 → react-complex-tree 的扁平 items(合成 root)。 */
function buildItems(nodes: TreeNode[], rootName: string): Record<TreeItemIndex, TreeItem> {
  const items: Record<TreeItemIndex, TreeItem> = {
    __root__: { index: "__root__", isFolder: true, data: { name: rootName }, children: [] },
  };
  const walk = (node: TreeNode, parentId: string): void => {
    if (!node.entryId) return; // 防御:底座/映射给的节点缺锚时跳过,不渲染
    const childIds = (node.children ?? []).map((c) => c.entryId).filter(Boolean);
    items[node.entryId] = {
      index: node.entryId,
      isFolder: childIds.length > 0,
      canRename: false,
      canMove: false,
      data: { name: node.label ?? node.entryId.slice(0, 8), entryId: node.entryId },
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
  const { t } = useTranslation();
  const { currentCwd, currentSessionPath, requestBookmark } = useUiStore();
  const { snapshot, ready } = useSessionStore();
  const nodes = snapshot?.tree ?? [];
  const items = useMemo(() => buildItems(nodes, t("system.sessionTree")), [nodes, t]);

  const handleBookmarkNode = (entryId: string, label?: string): void => {
    if (!currentSessionPath) return;
    requestBookmark({
      sessionPath: currentSessionPath,
      entryId,
      preview: label ?? entryId.slice(0, 8),
    });
  };

  if (!currentCwd) return <EmptyState icon={<ListTree className="size-8" />} title="先打开文件夹" />;
  if (!ready || nodes.length === 0) {
    return <EmptyState icon={<ListTree className="size-8" />} title={t("system.sessionTree")} description="" />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex justify-end px-2 pt-1 shrink-0">
        <button onClick={() => void ctx.sessions.sync().catch(() => {})} title={t("common.refresh")} style={refreshBtnStyle}>
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
          renderItemTitle={({ item }) => (
            <div className="flex items-center gap-1 group/item">
              <span>{(item.data as { name: string }).name}</span>
              {item.index !== "__root__" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBookmarkNode(
                      (item.data as { entryId: string }).entryId,
                      (item.data as { name: string }).name,
                    );
                  }}
                  title="收藏此节点"
                  className="opacity-0 group-hover/item:opacity-100 transition-opacity text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0.5"
                >
                  <Bookmark className="size-3" />
                </button>
              )}
            </div>
          )}
        >
          <Tree treeId="session-tree" rootItem="__root__" treeLabel={t("system.sessionTree")} />
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
