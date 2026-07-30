import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare, Pin } from "lucide-react";
import { ListItem, type StylePreset } from "@pi-desktop/react";

export interface SidebarStylePreviewCardProps {
  preset: StylePreset;
  active: boolean;
  onSelect: () => void;
}

export function SidebarStylePreviewCard({ preset, active, onSelect }: SidebarStylePreviewCardProps): ReactNode {
  const { t } = useTranslation();
  return (
    <ListItem
      active={active}
      onClick={onSelect}
      style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", padding: "var(--spacing-sm)" }}
    >
      {/*
       * 预览卡挂 data-sidebar-style —— 直接吃 index.css 的 [data-sidebar-style="<id>"] 属性选择器块。
       * 预览与生产用同一条 CSS 路径(值漂移物理上不可能),不再从 TS vars map 注入副本。
       */}
      <div
        data-sidebar-style={preset.id}
        style={{
          height: "260px",
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
            paddingLeft: "var(--sidebar-row-px)",
            paddingTop: "var(--sidebar-section-pt)",
            paddingBottom: "var(--sidebar-section-pb)",
            fontSize: "var(--sidebar-section-fs)",
            color: "var(--color-muted)",
          }}
        >
          <span style={{ fontSize: "9px" }}>▼</span>
          <span>已置顶</span>
        </div>

        <PreviewRow active={true} icon={<Pin style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)", color: "var(--color-primary)" }} />} title="调试认证 bug" sub="2 分钟前" />

        <div
          style={{
            display: "var(--sidebar-arrow-display)",
            alignItems: "center",
            gap: "4px",
            paddingLeft: "var(--sidebar-row-px)",
            paddingTop: "var(--sidebar-section-pt)",
            paddingBottom: "var(--sidebar-section-pb)",
            fontSize: "var(--sidebar-section-fs)",
            color: "var(--color-muted)",
          }}
        >
          <span style={{ fontSize: "9px" }}>▼</span>
          <span>今天</span>
        </div>

        <PreviewRow active={false} icon={<MessageSquare style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)", color: "var(--color-muted)" }} />} title="重构数据层" sub="10 分钟前" />
        <PreviewRow active={false} icon={<MessageSquare style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)", color: "var(--color-muted)" }} />} title="新建项目脚手架" sub="1 小时前" />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", fontSize: "var(--font-size-sm)" }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", border: active ? "2px solid var(--color-primary)" : "1px solid var(--color-border)", flexShrink: 0 }} />
        {t(preset.labelKey)}
      </div>
    </ListItem>
  );
}

function PreviewRow({ active, icon, title, sub }: {
  active: boolean;
  icon: ReactNode;
  title: string;
  sub: string;
}): ReactNode {
  // 不再从 TS vars map 注入副本；消费 var(--sidebar-row-*) 等 CSS vars
  // —— 它们自动从 [data-sidebar-style] 属性选择器块经 CSS vars 继承进入子树。
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "var(--sidebar-row-py) var(--sidebar-row-px)",
        margin: "0 8px var(--sidebar-row-gap)",
        background: active ? "var(--sidebar-row-bg-active)" : "var(--sidebar-row-bg)",
        border: active ? "var(--sidebar-row-border-active)" : "var(--sidebar-row-border)",
        borderRadius: "var(--sidebar-row-radius)",
        boxShadow: active ? "var(--sidebar-row-shadow-active)" : "var(--sidebar-row-shadow)",
        transition: "background 0.12s, border-color 0.12s, box-shadow 0.12s",
      }}
    >
      <div style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ fontSize: "11px", color: "var(--color-muted)", marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  );
}
