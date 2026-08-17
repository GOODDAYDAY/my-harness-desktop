// session-tree 插件 renderer —— 右面板 Tree 页签:git-graph 化会话地图。
//
// 数据:snapshot.tree 投影已带 entryType/preview/timestamp/label,只读 store,不拉取。
// 渲染:泳道铁轨(白=主干,黄/绿=旁支)+ 分组色点 + 分叉弧线与徽章;空 preview 行已由
//   context-binding 兜底(assistant 无文本块时取工具调用名),这里再 || 兜底一次。
// 交互:单击节点→timeline:scrollTo 定位;hover 动作:Fork(ctx.tree.fork)/收藏(事件)/复制 preview。
// 过滤:仿底座 TUI /tree 的 Ctrl+O 模式;无信息事件链自动压缩;顶栏 ⤢ 开全景泳道。
import { useMemo, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ListTree, RefreshCw, Maximize2, Crosshair, ChevronRight, ChevronDown,
  GitFork, Bookmark, Copy, Check,
} from "lucide-react";
import { usePluginContext, useUiStore, useSessionStore, EmptyState, InlineConfirmInput, useArmConfirm } from "@pi-desktop/react";
import type { TreeNode } from "@pi-desktop/react";
import type { LineageTree } from "@pi-desktop/contract";
import { FullscreenMap } from "./fullscreen-map";
import {
  matchesFilter, visibleForest, compressedRows, relTime, groupOf,
  type TreeFilter, type DisplayRow,
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

const ROW_H = 26;
const LANE_W = 14;
/** 泳道铁轨色:主干用 primary,旁支依次 warning/success/muted,色深即层级。 */
const railColor = (d: number): string => {
  const base = ["var(--color-primary)", "var(--color-accent-warning)", "var(--color-accent-success)", "var(--color-muted)"][Math.min(d, 3)];
  return `color-mix(in srgb, ${base} ${d === 0 ? 45 : 55}%, transparent)`;
};

/** 行左侧泳道 gutter:延续竖轨 + 本行轨道与节点点 + 分叉弧线;叶子加环,压缩链用虚线方块。 */
function RowGutter({ row, leafId }: { row: DisplayRow; leafId: string | null }): React.ReactNode {
  const d0 = row.depth;
  const w = 10 + d0 * LANE_W;
  const cx = 7 + d0 * LANE_W;
  const cy = ROW_H / 2;
  const g = groupOf(row.node.entryType);
  const isLeaf = row.node.entryId === leafId;
  return (
    <svg width={w} height={ROW_H} className="shrink-0" style={{ display: "block" }}>
      {row.cont.slice(0, d0).map((on, d) =>
        on ? <line key={d} x1={7 + d * LANE_W} y1={0} x2={7 + d * LANE_W} y2={ROW_H} stroke={railColor(d)} strokeWidth={1.5} /> : null,
      )}
      <line x1={cx} y1={0} x2={cx} y2={row.cont[d0] ? ROW_H : cy} stroke={railColor(d0)} strokeWidth={1.5} />
      {row.forkKids > 0 && (
        <path
          d={`M ${cx} ${cy} C ${cx} ${cy + 9}, ${cx + LANE_W} ${cy + 4}, ${cx + LANE_W} ${ROW_H}`}
          stroke={railColor(d0 + 1)} strokeWidth={1.5} fill="none"
        />
      )}
      {row.run ? (
        <rect x={cx - 4} y={cy - 4} width={8} height={8} rx={2} fill="none" stroke="var(--color-muted)" strokeWidth={1.2} strokeDasharray="2 2" />
      ) : (
        <>
          <circle cx={cx} cy={cy} r={4} fill={dotColor(row.node.entryType)} />
          {isLeaf && <circle cx={cx} cy={cy} r={7} fill="none" stroke="var(--color-primary)" strokeWidth={1.5} opacity={0.9} />}
        </>
      )}
      {g === "label" && !row.run && <circle cx={cx} cy={cy} r={6.5} fill="none" stroke="var(--color-accent-warning)" strokeWidth={1} opacity={0.6} />}
    </svg>
  );
}

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
  const [overviewMode, setOverviewMode] = useState(false);
  const [lineageTree, setLineageTree] = useState<LineageTree | null>(null);
  const { armed: forkArmedId, arm: armFork, disarm: disarmFork } = useArmConfirm<string>();
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);

  // 分支概览:走底座 getTree(fork-point lineage 树),与逐条明细树并存,概览时才拉取。
  useEffect(() => {
    if (!overviewMode || !currentSessionPath) return;
    let cancelled = false;
    void ctx.sessions.getTree(currentSessionPath)
      .then((tree) => { if (!cancelled) setLineageTree(tree); })
      .catch(() => { if (!cancelled) setLineageTree(null); });
    return () => { cancelled = true; };
  }, [overviewMode, currentSessionPath, ctx]);

  const nodes = useMemo(() => snapshot?.tree ?? [], [snapshot]);
  const leafId = snapshot?.leafId ?? null;
  // 默认 label = 会话名(与 timeline 收藏同一拍板);无名会话回退节点预览
  const sessionName = snapshot?.state.sessionName ?? null;
  // pred 必须同一引用贯穿 visibleForest 与 compressedRows(节点 children 是原数组,walk 靠 pred 重取可见子节点)
  const pred = useMemo(() => (n: TreeNode) => matchesFilter(n, filter), [filter]);
  const forest = useMemo(() => visibleForest(nodes, pred), [nodes, pred]);
  const rows = useMemo(
    () => compressedRows(forest, pred, leafId, expandedRuns, collapsed),
    [forest, pred, leafId, expandedRuns, collapsed],
  );
  const stats = useMemo(() => {
    let users = 0, assistants = 0, tools = 0, forks = 0, total = 0;
    const walk = (ns: TreeNode[]): void => {
      for (const n of ns) {
        total++;
        if (n.entryType === "user") users++;
        else if (n.entryType === "assistant") assistants++;
        else if (groupOf(n.entryType) === "tool") tools++;
        if ((n.children ?? []).length > 1) forks++;
        walk(n.children ?? []);
      }
    };
    walk(nodes);
    return { users, assistants, tools, forks, total };
  }, [nodes]);
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
    void ctx.tree.fork(currentSessionPath ?? "", node.entryId).catch(() => {});
  };
  const copyPreview = (node: TreeNode): void => {
    void navigator.clipboard.writeText(node.preview ?? "").then(() => {
      setCopiedId(node.entryId);
      setTimeout(() => setCopiedId((id) => (id === node.entryId ? null : id)), 1200);
    });
  };

  if (!currentCwd) return <EmptyState icon={<ListTree className="size-8" />} title={t("shell.openFolderFirst")} />;
  if (!ready || nodes.length === 0) {
    return <EmptyState icon={<ListTree className="size-8" />} title={t("system.sessionTree")} description={t("system.emptyTreeDesc")} />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2 pt-1.5 shrink-0">
        <div style={segStyle}>
          {FILTERS.map((f, i) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                ...segBtnBase,
                ...(i > 0 ? { borderLeft: "1px solid var(--color-border)" } : {}),
                ...(f === filter ? { background: "var(--color-list-selected-bg)", color: "var(--color-fg)" } : {}),
              }}
            >
              {t(FILTER_KEY[f])}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setOverviewMode((v) => !v)}
          title="分支概览"
          style={{ ...iconBtnStyle, ...(overviewMode ? { background: "var(--color-list-selected-bg)" } : {}) }}
        >
          <GitFork className="size-3.5" />
        </button>
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
      <div className="px-2.5 pt-1 pb-1.5 shrink-0 text-[length:var(--font-size-xs)] text-[var(--color-muted)]" style={{ borderBottom: "1px solid var(--color-border)" }}>
        <span className="text-[var(--color-accent-warning)] font-medium">{t("system.statBranches", { n: stats.forks })}</span>
        {" · "}{t("system.statUser", { n: stats.users })}
        {" · "}{t("system.statAssistant", { n: stats.assistants })}
        {" · "}{t("system.statTools", { n: stats.tools })}
        {" · "}{t("system.statTotal", { n: stats.total })}
      </div>
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        {overviewMode && (
          <div className="px-3 py-2 space-y-1">
            {lineageTree ? lineageTree.lineages.map((l) => (
              <div key={l.id} className="text-xs text-[var(--color-muted)]">
                {l.fork
                  ? `分支 ${l.id.slice(0, 8)}（从 ${l.fork.parentLineageId.slice(0, 8)} 第 ${l.fork.boundary} 分叉）`
                  : `根 ${l.id.slice(0, 8)}`}
              </div>
            )) : <div className="text-xs text-[var(--color-muted)]">分支概览加载中…</div>}
          </div>
        )}
        {!overviewMode && rows.map((row) => {
          const n = row.node;
          const isLeaf = n.entryId === leafId;
          const Icon = iconOf(n.entryType);
          const g = groupOf(n.entryType);
          return (
            <div
              key={(row.run ? "r:" : "n:") + n.entryId}
              className="group flex items-center pr-2 cursor-pointer hover:bg-[var(--color-surface)]"
              style={{
                height: ROW_H,
                ...(isLeaf ? { background: "var(--color-list-selected-bg)" } : {}),
              }}
              onClick={() => (row.run ? toggleIn(expandedRuns, setExpandedRuns, n.entryId) : locate(n))}
            >
              <RowGutter row={row} leafId={leafId} />
              {row.hasKids ? (
                <button
                  onClick={(e) => { e.stopPropagation(); toggleIn(collapsed, setCollapsed, n.entryId); }}
                  style={caretBtnStyle}
                >
                  {collapsed.has(n.entryId) ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                </button>
              ) : <span className="w-3 shrink-0" />}
              {row.run ? (
                <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] italic" style={runPillStyle}>
                  {t("system.collapsedEvents", { count: row.run.count })}
                </span>
              ) : (
                <>
                  <Icon className="size-3 shrink-0 mr-1" style={{ color: dotColor(n.entryType), opacity: 0.85 }} />
                  <span className="text-xs truncate" style={textStyleFor(g, n.entryType)}>
                    {n.label || n.preview || n.entryId.slice(0, 8)}
                  </span>
                  {row.forkKids > 0 && <span style={forkChipStyle}>⑂{row.forkKids + 1}</span>}
                </>
              )}
              <span className="ml-auto text-[length:var(--font-size-xs)] text-[var(--color-muted)] shrink-0" style={{ fontSize: 10 }}>
                {relTime(n.timestamp, now, lang)}
              </span>
              <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                {editingBookmarkId === n.entryId && currentSessionPath ? (
                  <span onClick={(e) => e.stopPropagation()}>
                    <InlineConfirmInput
                      inputStyle={{ width: 110 }}
                      defaultValue={sessionName ?? (n.label ?? n.preview ?? n.entryId.slice(0, 8))}
                      placeholder={t("system.bookmarkLabel")}
                      confirmTitle={t("common.confirm")}
                      cancelTitle={t("common.cancel")}
                      onConfirm={(label) => {
                        ctx.events.emit("session-tree:bookmarkRequested", {
                          sessionPath: currentSessionPath,
                          entryId: n.entryId,
                          preview: n.label ?? n.preview ?? n.entryId.slice(0, 8),
                          label,
                        });
                        setEditingBookmarkId(null);
                      }}
                      onCancel={() => setEditingBookmarkId(null)}
                    />
                  </span>
                ) : (
                  <>
                <button
                  onClick={(e) => { e.stopPropagation(); locate(n); }}
                  title={t("system.locateNode")}
                  style={actionBtnStyle}
                >
                  <Crosshair className="size-3" />
                </button>
                {/* fork/收藏挂 assistant 节点:收藏语义=从这条回答后继续(fork "at"),user 节点不提供入口 */}
                {n.entryType === "assistant" && (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (forkArmedId === n.entryId) { disarmFork(); fork(n); return; }
                        armFork(n.entryId);
                      }}
                      title={forkArmedId === n.entryId ? t("system.forkArmed") : t("system.forkFromHere")}
                      style={forkArmedId === n.entryId ? armedActionBtnStyle : actionBtnStyle}
                    >
                      {forkArmedId === n.entryId
                        ? <span className="text-[10px] whitespace-nowrap">{t("system.forkArmed")}</span>
                        : <GitFork className="size-3" />}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditingBookmarkId(n.entryId); }}
                      title={t("shell.bookmarkNode")}
                      style={actionBtnStyle}
                    >
                      <Bookmark className="size-3" />
                    </button>
                  </>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); copyPreview(n); }}
                  title={t("common.copy")}
                  style={actionBtnStyle}
                >
                  {copiedId === n.entryId ? <Check className="size-3" /> : <Copy className="size-3" />}
                </button>
                  </>
                )}
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

/** 文本配色按分组分层:用户最亮、助手次之、工具等宽 muted、事件斜体、标签警示色。 */
function textStyleFor(g: string, entryType?: string): React.CSSProperties {
  if (entryType === "user") return { color: "var(--color-fg)", fontWeight: 500 };
  if (entryType === "assistant") return { color: "color-mix(in srgb, var(--color-fg) 80%, transparent)" };
  if (g === "tool") return { color: "var(--color-muted)", fontFamily: "var(--font-family-mono)", fontSize: 11 };
  if (g === "label") return { color: "var(--color-accent-warning)" };
  return { color: "var(--color-muted)", fontStyle: "italic" };
}

const segStyle: React.CSSProperties = {
  display: "flex", background: "var(--color-surface)", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)", overflow: "hidden",
};

const segBtnBase: React.CSSProperties = {
  border: "none", background: "transparent", color: "var(--color-muted)",
  fontSize: "var(--font-size-xs)", padding: "3px 9px", cursor: "pointer",
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

const runPillStyle: React.CSSProperties = {
  border: "1px dashed var(--color-border)", borderRadius: "var(--radius-sm)",
  padding: "1px 8px",
};

const forkChipStyle: React.CSSProperties = {
  fontSize: 9.5, color: "var(--color-accent-warning)",
  border: "1px solid color-mix(in srgb, var(--color-accent-warning) 35%, transparent)",
  borderRadius: 3, padding: "0 4px", marginLeft: 6, flexShrink: 0, lineHeight: "14px",
};

const actionBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: "2px", border: "none", background: "transparent",
  color: "var(--color-muted)", cursor: "pointer",
};

const armedActionBtnStyle: React.CSSProperties = {
  ...actionBtnStyle, color: "var(--color-accent-error)",
};
