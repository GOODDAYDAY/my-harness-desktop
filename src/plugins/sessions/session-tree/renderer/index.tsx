// session-tree 插件 renderer —— 右面板 Tree 页签:会话地图(富节点分支树)。
//
// 数据:snapshot.tree 投影已带 entryType/preview/timestamp/label,isLeaf 由底座投影(只读 store,不拉取)。
// 交互:单击节点→timeline:scrollTo 定位;hover 动作:Fork(ctx.tree.fork)/收藏(事件)/复制 preview。
// 过滤:仿底座 TUI /tree 的 Ctrl+O 模式;无信息事件链自动压缩;顶栏 ⤢ 开全景泳道。
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ListTree, RefreshCw, Maximize2, Crosshair, ChevronRight, ChevronDown,
  GitFork, Bookmark, Copy, Check,
} from "lucide-react";
import { usePluginContext, useUiStore, useSessionStore, EmptyState } from "@pi-desktop/react";
import type { TreeNode } from "@pi-desktop/react";
import { FullscreenMap } from "./fullscreen-map";
import {
  matchesFilter, visibleForest, compressedRows, relTime,
  type TreeFilter,
} from "../core/tree-model";
import { iconOf, dotColor } from "../core/tree-visual";

export const channels = ["session-tree:bookmarkRequested"] as const;

const FILTERS: TreeFilter[] = ["all", "noTools", "userOnly", "labeled"];

const FILTER_KEY: Record<TreeFilter, string> = {
  all: "system.filterAll",
  noTools: "system.filterNoTools",
  userOnly: "system.filterUserOnly",
  labeled: "system.filterLabeled",
};

export function SessionTreeTab(): React.ReactNode {
  const ctx = usePluginContext();
  const { t, i18n } = useTranslation();
  const { currentCwd, currentSessionPath } = useUiStore();
  const { snapshot, ready } = useSessionStore();

  const [filter, setFilter] = useState<TreeFilter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);

  const nodes = useMemo(() => snapshot?.tree ?? [], [snapshot]);
  const leafId = snapshot?.leafId ?? null;
  // pred 必须同一引用贯穿 visibleForest 与 compressedRows(节点 children 是原数组,walk 靠 pred 重取可见子节点)
  const pred = useMemo(() => (n: TreeNode) => matchesFilter(n, filter), [filter]);
  const forest = useMemo(() => visibleForest(nodes, pred), [nodes, pred]);
  const rows = useMemo(
    () => compressedRows(forest, pred, expandedRuns, collapsed),
    [forest, pred, expandedRuns, collapsed],
  );
  const now = Date.now();
  const lang = i18n.language || "zh-CN";

  const toggleIn = (set: Set<string>, apply: (s: Set<string>) => void, id: string): void => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const locate = (node: TreeNode): void => {
    // scrollTo 是一次性命令不是可回放状态:invoke 定向分派(调用方不拥有 channel),
    // 无订阅者时入队、timeline 挂载时恰好一次投递;emit 会因权属校验直接抛错
    ctx.events.invoke("timeline:scrollTo", { messageId: node.entryId });
  };
  const fork = (node: TreeNode): void => {
    if (!window.confirm(t("system.forkConfirm"))) return;
    // fork 自带对账(sync+路径切换+sessionStart 水合),无需调用方补 sync。
    void ctx.tree.fork(node.entryId).catch(() => {});
  };
  const bookmark = (node: TreeNode): void => {
    if (!currentSessionPath) return;
    ctx.events.emit("session-tree:bookmarkRequested", {
      sessionPath: currentSessionPath,
      entryId: node.entryId,
      preview: node.label ?? node.preview ?? node.entryId.slice(0, 8),
    });
  };
  const copyPreview = (node: TreeNode): void => {
    void navigator.clipboard.writeText(node.preview ?? "").then(() => {
      setCopiedId(node.entryId);
      setTimeout(() => setCopiedId((id) => (id === node.entryId ? null : id)), 1200);
    });
  };

  if (!currentCwd) return <EmptyState icon={<ListTree className="size-8" />} title={t("shell.openFolderFirst")} />;
  if (!ready || nodes.length === 0) {
    return <EmptyState icon={<ListTree className="size-8" />} title={t("system.sessionTree")} description="" />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2 pt-1 shrink-0">
        {FILTERS.map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={f === filter ? filterOnStyle : filterOffStyle}>
            {t(FILTER_KEY[f])}
          </button>
        ))}
        <div className="flex-1" />
        {leafId && (
          <button
            onClick={() => ctx.events.invoke("timeline:scrollTo", { messageId: leafId })}
            title={t("system.backToLeaf")}
            style={iconBtnStyle}
          >
            <Crosshair className="size-3.5" />
          </button>
        )}
        <button onClick={() => setMapOpen(true)} title={t("system.mapView")} style={iconBtnStyle}>
          <Maximize2 className="size-3.5" />
        </button>
        <button onClick={() => void ctx.sessions.sync().catch(() => {})} title={t("common.refresh")} style={iconBtnStyle}>
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        {rows.map((row) => {
          const n = row.node;
          const isLeaf = n.entryId === leafId;
          const Icon = iconOf(n.entryType);
          return (
            <div
              key={(row.run ? "r:" : "n:") + n.entryId}
              className="group flex items-center gap-1.5 pr-2 py-0.5 cursor-pointer hover:bg-[var(--color-surface)]"
              style={{
                paddingLeft: 8 + row.depth * 12,
                ...(isLeaf ? { background: "var(--color-list-selected-bg)" } : {}),
              }}
              onClick={() => (row.run ? toggleIn(expandedRuns, setExpandedRuns, n.entryId) : locate(n))}
            >
              {row.hasKids ? (
                <button
                  onClick={(e) => { e.stopPropagation(); toggleIn(collapsed, setCollapsed, n.entryId); }}
                  style={caretBtnStyle}
                >
                  {collapsed.has(n.entryId) ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                </button>
              ) : <span className="size-3 shrink-0" />}
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor(n.entryType), flexShrink: 0 }} />
              <Icon className="size-3.5 shrink-0 text-[var(--color-muted)]" />
              {row.run ? (
                <span className="text-xs text-[var(--color-muted)] italic">
                  {t("system.collapsedEvents", { count: row.run.count })}
                </span>
              ) : (
                <span className="text-xs truncate">{n.label ?? n.preview ?? n.entryId.slice(0, 8)}</span>
              )}
              {isLeaf && <Crosshair className="size-3 shrink-0 text-[var(--color-primary)]" />}
              <span className="ml-auto text-[10px] text-[var(--color-muted)] shrink-0">
                {relTime(n.timestamp, now, lang)}
              </span>
              <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); locate(n); }}
                  title={t("system.locateNode")}
                  style={actionBtnStyle}
                >
                  <Crosshair className="size-3" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); fork(n); }}
                  title={t("system.forkFromHere")}
                  style={actionBtnStyle}
                >
                  <GitFork className="size-3" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); bookmark(n); }}
                  title={t("shell.bookmarkNode")}
                  style={actionBtnStyle}
                >
                  <Bookmark className="size-3" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); copyPreview(n); }}
                  title={t("common.copy")}
                  style={actionBtnStyle}
                >
                  {copiedId === n.entryId ? <Check className="size-3" /> : <Copy className="size-3" />}
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {mapOpen && (
        <FullscreenMap
          nodes={nodes}
          leafId={leafId}
          onLocate={(n) => { locate(n); setMapOpen(false); }}
          onClose={() => setMapOpen(false)}
        />
      )}
    </div>
  );
}

const filterBtnBase: React.CSSProperties = {
  padding: "1px 8px", fontSize: "11px", borderRadius: "var(--radius-sm)",
  border: "1px solid var(--color-border)", cursor: "pointer", background: "transparent",
};

const filterOnStyle: React.CSSProperties = {
  ...filterBtnBase, color: "var(--color-primary)", borderColor: "var(--color-primary)",
};

const filterOffStyle: React.CSSProperties = {
  ...filterBtnBase, color: "var(--color-muted)",
};

const iconBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "24px", height: "24px", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)", background: "transparent",
  color: "var(--color-muted)", cursor: "pointer",
};

const caretBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "12px", height: "12px", border: "none", background: "transparent",
  color: "var(--color-muted)", cursor: "pointer", padding: 0, flexShrink: 0,
};

const actionBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: "2px", border: "none", background: "transparent",
  color: "var(--color-muted)", cursor: "pointer",
};
