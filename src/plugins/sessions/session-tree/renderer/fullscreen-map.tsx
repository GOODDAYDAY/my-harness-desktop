// fullscreen-map —— 会话地图全景覆盖层(createPortal 到 body):SVG git-graph。
//
// 布局:主干(root→当前叶子)在左轨,旁支按末条时间倒序依次右排;节点 y 取全局
// 时间序等距,跨泳道边画贝塞尔曲线。悬停节点出详情 tooltip,点击=定位并关闭(父组件统一关),
// Esc/点 backdrop/× 关闭。相邻节点间隔 >20 分钟画弱时间分隔线,给出节奏感。
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useSessionStore } from "@pi-desktop/react";
import type { TreeNode } from "@pi-desktop/react";
import { branchLanes, uniqueSegment, groupOf } from "../core/tree-model";
import { dotColor } from "../core/tree-visual";

const LANE_X0 = 110;
const LANE_DX = 190;
const ROW_DY = 24;
const PAD_Y = 60;
/** 泳道色:0=主干 primary,旁支依次 warning/success/muted/error。 */
const laneColor = (l: number): string =>
  ["var(--color-primary)", "var(--color-accent-warning)", "var(--color-accent-success)", "var(--color-muted)", "var(--color-accent-error)"][Math.min(l, 4)];

interface Tooltip { x: number; y: number; node: TreeNode }

export function FullscreenMap(props: {
  nodes: TreeNode[];
  leafId: string | null;
  onLocate: (node: TreeNode) => void;
  onClose: () => void;
}): React.ReactNode {
  const { nodes, leafId, onLocate, onClose } = props;
  const { t } = useTranslation();
  const { snapshot } = useSessionStore();
  const sessionName = snapshot?.state.sessionName ?? null;
  const [tip, setTip] = useState<Tooltip | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const graph = useMemo(() => {
    const { main, others } = branchLanes(nodes, leafId);
    // 泳道归属:主干=0;旁支只画独有段(去公共前缀,保留分叉点)
    const laneOf = new Map<string, number>();
    main.forEach((n) => laneOf.set(n.entryId, 0));
    others.forEach((path, i) => {
      uniqueSegment(path, main).forEach((n) => {
        if (!laneOf.has(n.entryId)) laneOf.set(n.entryId, i + 1);
      });
    });
    // y = 全局时间序等距
    const all: TreeNode[] = [];
    const flat = (ns: TreeNode[]): void => {
      for (const n of ns) { all.push(n); flat(n.children ?? []); }
    };
    flat(nodes);
    all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const pos = new Map(all.map((n, i) => [n.entryId, {
      x: LANE_X0 + (laneOf.get(n.entryId) ?? 0) * LANE_DX,
      y: PAD_Y + i * ROW_DY,
      n,
    }]));
    const gaps = new Set<number>();
    for (let i = 1; i < all.length; i++) {
      if ((all[i].timestamp ?? 0) - (all[i - 1].timestamp ?? 0) > 20 * 60000) gaps.add(i);
    }
    return {
      main, others, laneOf, all, pos, gaps,
      width: LANE_X0 + (others.length + 1) * LANE_DX + 320,
      height: PAD_Y + all.length * ROW_DY + 60,
    };
  }, [nodes, leafId]);

  const { main, others, laneOf, all, pos, gaps } = graph;

  return createPortal(
    <div style={backdropStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 py-2.5 shrink-0" style={{ borderBottom: "1px solid var(--color-border)" }}>
          <span className="text-sm font-medium">{sessionName ?? t("system.mapView")}</span>
          <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
            <span className="text-[var(--color-accent-warning)] font-medium">{t("system.statBranches", { n: others.length })}</span>
            {" · "}{t("system.statTotal", { n: all.length })}
            {all.length > 1 && all[0].timestamp && all[all.length - 1].timestamp && (
              <>{" · "}{new Date(all[0].timestamp!).toLocaleString(lang(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              {" → "}{new Date(all[all.length - 1].timestamp!).toLocaleTimeString(lang(), { hour: "2-digit", minute: "2-digit" })}</>
            )}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} title={t("system.closeView")} style={closeBtnStyle}>
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto min-h-0" style={{ position: "relative" }}>
          {main.length > 0 && (
            <div className="laneHead" style={laneHeadStyle(0)}>{t("system.laneCurrent")}</div>
          )}
          {others.map((path, i) => (
            <div key={i} className="laneHead" style={laneHeadStyle(i + 1)}>
              {t("system.laneOtherCount", { n: i + 1, count: uniqueSegment(path, main).length - 1 })}
            </div>
          ))}
          <svg width={graph.width} height={graph.height} style={{ display: "block" }}>
            {Array.from({ length: others.length + 1 }, (_, l) => {
              const pts = [...pos.values()].filter((p) => (laneOf.get(p.n.entryId) ?? 0) === l);
              if (pts.length === 0) return null;
              const x = LANE_X0 + l * LANE_DX;
              const ys = pts.map((p) => p.y);
              return (
                <line
                  key={l} x1={x} y1={Math.min(...ys)} x2={x} y2={Math.max(...ys)}
                  stroke={laneColor(l)} strokeWidth={l === 0 ? 2 : 1.5} opacity={l === 0 ? 0.5 : 0.35}
                />
              );
            })}
            {[...pos.values()].flatMap((p) =>
              (p.n.children ?? []).map((c) => {
                const q = pos.get(c.entryId);
                if (!q) return null;
                const l = laneOf.get(c.entryId) ?? 0;
                const pl = laneOf.get(p.n.entryId) ?? 0;
                if (l === pl) return null;
                return (
                  <path
                    key={c.entryId}
                    d={`M ${p.x} ${p.y} C ${p.x} ${p.y + 16}, ${q.x} ${q.y - 16}, ${q.x} ${q.y}`}
                    stroke={laneColor(l)} strokeWidth={1.5} fill="none" opacity={0.8}
                  />
                );
              }),
            )}
            {[...gaps].map((i) => {
              const y = PAD_Y + i * ROW_DY - ROW_DY / 2;
              const ts = all[i].timestamp;
              return (
                <g key={i}>
                  <line x1={30} y1={y} x2={graph.width - 40} y2={y} stroke="var(--color-border)" strokeDasharray="3 5" />
                  {ts && (
                    <text x={34} y={y - 4} fill="var(--color-muted)" fontSize={10}>
                      {new Date(ts).toLocaleTimeString(lang(), { hour: "2-digit", minute: "2-digit" })}
                    </text>
                  )}
                </g>
              );
            })}
            {[...pos.values()].map((p) => {
              const n = p.n;
              const g = groupOf(n.entryType);
              const l = laneOf.get(n.entryId) ?? 0;
              const isLeaf = n.entryId === leafId;
              const isFork = (n.children ?? []).length > 1;
              const r = g === "chat" ? 5 : 3.5;
              const label = n.label || n.preview || "";
              return (
                <g
                  key={n.entryId}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY, node: n })}
                  onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, node: n })}
                  onMouseLeave={() => setTip(null)}
                  onClick={() => onLocate(n)}
                >
                  <circle cx={p.x} cy={p.y} r={14} fill="transparent" />
                  <circle
                    cx={p.x} cy={p.y} r={r + (isFork ? 2.5 : 0)} fill={dotColor(n.entryType)}
                    stroke={isFork ? laneColor(l + 1) : "none"} strokeWidth={isFork ? 2 : 0}
                  />
                  {isLeaf && <circle cx={p.x} cy={p.y} r={r + 6} fill="none" stroke="var(--color-primary)" strokeWidth={2} />}
                  {(g === "chat" || g === "label") && label && (
                    <text
                      x={p.x + 12} y={p.y + 4} fontSize={11}
                      fill={g === "label" ? "var(--color-accent-warning)" : n.entryType === "user" ? "var(--color-fg)" : "color-mix(in srgb, var(--color-fg) 72%, transparent)"}
                    >
                      {label.length > 34 ? label.slice(0, 34) + "…" : label}
                    </text>
                  )}
                  {isLeaf && (
                    <text x={p.x - 8} y={p.y - 12} fill="var(--color-primary)" fontSize={10} textAnchor="end">
                      ◉ {t("system.currentMark")}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
        <div className="flex items-center gap-3.5 px-4 py-2 shrink-0 text-[length:var(--font-size-xs)] text-[var(--color-muted)]" style={{ borderTop: "1px solid var(--color-border)" }}>
          <LegendDot color="var(--color-primary)" label={t("system.legendChat")} />
          <LegendDot color="var(--color-accent-success)" label={t("system.legendTool")} />
          <LegendDot color="var(--color-accent-warning)" label={t("system.legendLabel")} />
          <LegendDot color="var(--color-muted)" label={t("system.legendEvent")} />
          <span className="ml-auto">{t("system.mapHint")}</span>
        </div>
      </div>
      {tip && (
        <div style={{ ...tooltipStyle, left: tip.x + 14, top: tip.y + 12 }}>
          <div className="text-[var(--color-muted)]" style={{ fontSize: 10, marginBottom: 2 }}>
            {tip.node.entryType}{tip.node.timestamp ? " · " + new Date(tip.node.timestamp).toLocaleTimeString(lang()) : ""}
          </div>
          {(tip.node.label || tip.node.preview || tip.node.entryId.slice(0, 8)).slice(0, 300)}
        </div>
      )}
    </div>,
    document.body,
  );
}

function lang(): string {
  return document.documentElement.lang || "zh-CN";
}

function LegendDot({ color, label }: { color: string; label: string }): React.ReactNode {
  return (
    <span className="flex items-center gap-1">
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}

const laneHeadStyle = (lane: number): React.CSSProperties => ({
  position: "absolute", top: 8, left: LANE_X0 + lane * LANE_DX - 40, zIndex: 2,
  fontSize: 11, fontWeight: 600, padding: "2px 10px", borderRadius: 10,
  background: "var(--color-surface)", border: `1px solid color-mix(in srgb, ${laneColor(lane)} 35%, transparent)`,
  color: laneColor(lane), whiteSpace: "nowrap",
});

const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.5)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};

const panelStyle: React.CSSProperties = {
  width: "88%", height: "84%", display: "flex", flexDirection: "column",
  background: "var(--color-bg)", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-lg, 8px)", overflow: "hidden",
};

const closeBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "24px", height: "24px", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)", background: "transparent",
  color: "var(--color-muted)", cursor: "pointer",
};

const tooltipStyle: React.CSSProperties = {
  position: "fixed", zIndex: 1100, maxWidth: 360, fontSize: 11.5, lineHeight: 1.5,
  background: "var(--color-surface)", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)", padding: "8px 10px",
  pointerEvents: "none", boxShadow: "var(--shadow-lg)",
};
