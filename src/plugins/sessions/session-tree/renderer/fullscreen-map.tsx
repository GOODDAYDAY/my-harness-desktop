// fullscreen-map —— 会话地图全景泳道覆盖层(createPortal 到 body)。
//
// 数据:branchLanes 主泳道(当前分支全路径)+副泳道(去公共前缀的独有段,首元素为分叉点)。
// 交互:点节点=定位并关闭(由父组件统一关);Esc/点 backdrop/× 关闭。
import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X, GitFork, Crosshair } from "lucide-react";
import type { TreeNode } from "@pi-desktop/react";
import { branchLanes, uniqueSegment, relTime } from "../core/tree-model";
import { iconOf, dotColor } from "../core/tree-visual";

export function FullscreenMap(props: {
  nodes: TreeNode[];
  leafId: string | null;
  onLocate: (node: TreeNode) => void;
  onClose: () => void;
}): React.ReactNode {
  const { nodes, leafId, onLocate, onClose } = props;
  const { t, i18n } = useTranslation();
  const lanes = useMemo(() => branchLanes(nodes, leafId), [nodes, leafId]);
  const now = Date.now();
  const lang = i18n.language || "zh-CN";

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const renderNode = (n: TreeNode, isForkPoint: boolean): React.ReactNode => {
    const Icon = iconOf(n.entryType);
    const isCurrent = n.entryId === leafId;
    return (
      <button
        key={n.entryId}
        onClick={() => onLocate(n)}
        title={n.preview}
        style={{
          ...laneNodeStyle,
          ...(isCurrent ? { background: "var(--color-list-selected-bg)" } : {}),
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor(n.entryType), flexShrink: 0 }} />
        <Icon className="size-3.5 shrink-0 text-[var(--color-muted)]" />
        <span className="text-xs truncate">{n.label ?? n.preview ?? n.entryId.slice(0, 8)}</span>
        {isForkPoint && <GitFork className="size-3 shrink-0 text-[var(--color-accent-warning)]" />}
        {isCurrent && <Crosshair className="size-3 shrink-0 text-[var(--color-primary)]" />}
        <span className="ml-auto text-[10px] text-[var(--color-muted)] shrink-0">
          {relTime(n.timestamp, now, lang)}
        </span>
      </button>
    );
  };

  const renderLane = (title: string, path: TreeNode[], forkPointFirst: boolean): React.ReactNode => (
    <div key={title} style={laneStyle}>
      <div className="text-xs font-medium px-2 py-1 shrink-0" style={{ borderBottom: "1px solid var(--color-border)" }}>
        {title}
      </div>
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        {path.map((n, i) => renderNode(n, forkPointFirst && i === 0))}
      </div>
    </div>
  );

  return createPortal(
    <div style={backdropStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center px-3 py-2 shrink-0" style={{ borderBottom: "1px solid var(--color-border)" }}>
          <span className="text-sm font-medium">{t("system.mapView")}</span>
          <div className="flex-1" />
          <button onClick={onClose} title={t("system.closeView")} style={closeBtnStyle}>
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 flex gap-2 p-2 overflow-x-auto min-h-0">
          {lanes.main.length > 0 && renderLane(t("system.laneCurrent"), lanes.main, false)}
          {lanes.others.map((path, i) =>
            renderLane(
              t("system.laneOther", { n: i + 1 }),
              uniqueSegment(path, lanes.main),
              true,
            ),
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.5)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};

const panelStyle: React.CSSProperties = {
  width: "85%", height: "80%", display: "flex", flexDirection: "column",
  background: "var(--color-bg)", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-lg, 8px)", overflow: "hidden",
};

const laneStyle: React.CSSProperties = {
  width: "220px", flexShrink: 0, display: "flex", flexDirection: "column",
  border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)", overflow: "hidden",
};

const laneNodeStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "6px", width: "100%",
  padding: "3px 8px", border: "none", background: "transparent",
  color: "var(--color-fg)", cursor: "pointer", textAlign: "left",
};

const closeBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "24px", height: "24px", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)", background: "transparent",
  color: "var(--color-muted)", cursor: "pointer",
};
