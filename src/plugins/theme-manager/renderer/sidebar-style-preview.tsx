import { type CSSProperties, type ReactNode } from "react";
import { MessageSquare, Pin } from "lucide-react";
import { ListItem, type SidebarStylePreset } from "@pi-desktop/react";

export interface SidebarStylePreviewCardProps {
  preset: SidebarStylePreset;
  active: boolean;
  onSelect: () => void;
}

export function SidebarStylePreviewCard({ preset, active, onSelect }: SidebarStylePreviewCardProps): ReactNode {
  const vars = preset.vars as CSSProperties;
  return (
    <ListItem
      active={active}
      onClick={onSelect}
      style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", padding: "var(--spacing-sm)" }}
    >
      <div
        style={{
          ...vars,
          height: "220px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--color-border)",
          background: "var(--color-chrome)",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            display: "var(--sidebar-arrow-display)",
            alignItems: "center",
            gap: "4px",
            paddingLeft: "10px",
            paddingTop: "var(--sidebar-section-pt)",
            paddingBottom: "var(--sidebar-section-pb)",
            fontSize: "var(--sidebar-section-fs)",
            color: "var(--color-muted)",
          }}
        >
          <span style={{ fontSize: "10px" }}>▼</span>
          <span>已置顶</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "var(--sidebar-row-py) 10px",
            margin: "0 8px var(--sidebar-row-gap)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-surface)",
          }}
        >
          <div style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Pin style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)", color: "var(--color-primary)" }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>调试认证 bug</div>
            <div style={{ fontSize: "12px", color: "var(--color-muted)", marginTop: 2 }}>2 分钟前</div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            paddingLeft: "10px",
            paddingTop: "var(--sidebar-section-pt)",
            paddingBottom: "var(--sidebar-section-pb)",
            fontSize: "var(--sidebar-section-fs)",
            color: "var(--color-muted)",
          }}
        >
          <span style={{ display: "var(--sidebar-arrow-display)", fontSize: "10px" }}>▼</span>
          <span>今天</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "var(--sidebar-row-py) 10px",
            margin: "0 8px var(--sidebar-row-gap)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <div style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <MessageSquare style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)", color: "var(--color-muted)" }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>重构数据层</div>
            <div style={{ fontSize: "12px", color: "var(--color-muted)", marginTop: 2 }}>10 分钟前</div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "var(--sidebar-row-py) 10px",
            margin: "0 8px var(--sidebar-row-gap)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <div style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <MessageSquare style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)", color: "var(--color-muted)" }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>新建项目脚手架</div>
            <div style={{ fontSize: "12px", color: "var(--color-muted)", marginTop: 2 }}>1 小时前</div>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", fontSize: "var(--font-size-sm)" }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", border: active ? "2px solid var(--color-primary)" : "1px solid var(--color-border)", flexShrink: 0 }} />
        {preset.label}
      </div>
    </ListItem>
  );
}
