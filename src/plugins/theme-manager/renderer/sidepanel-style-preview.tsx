import { type CSSProperties, type ReactNode } from "react";
import { FileText, RefreshCw, MessageSquare, BarChart3 } from "lucide-react";
import { ListItem, PanelRow, PanelToolbar, PanelIconButton, PanelStatRow, PanelSectionTitle, type SidepanelStylePreset } from "@pi-desktop/react";

export interface SidepanelStylePreviewCardProps {
  preset: SidepanelStylePreset;
  active: boolean;
  onSelect: () => void;
}

export function SidepanelStylePreviewCard({ preset, active, onSelect }: SidepanelStylePreviewCardProps): ReactNode {
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
          height: "300px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "row",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--color-border)",
          background: "var(--color-chrome)",
          pointerEvents: "none",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--sidepanel-icon-gap)", padding: "8px 4px", flexShrink: 0, borderRight: "1px solid var(--color-border)" }}>
          <div style={{ width: "var(--sidepanel-icon-btn-size)", height: "var(--sidepanel-icon-btn-size)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--sidepanel-icon-btn-radius)", border: "var(--sidepanel-icon-btn-border)", background: "var(--sidepanel-icon-btn-bg-active)", position: "relative" }}>
            <span style={{ position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)", height: "16px", borderLeft: "var(--sidepanel-icon-active-indicator)" }} />
            <FileText style={{ width: "var(--sidepanel-icon-size)", height: "var(--sidepanel-icon-size)", color: "var(--color-fg)" }} />
          </div>
          <div style={{ width: "var(--sidepanel-icon-btn-size)", height: "var(--sidepanel-icon-btn-size)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--sidepanel-icon-btn-radius)", border: "var(--sidepanel-icon-btn-border)", background: "var(--sidepanel-icon-btn-bg)" }}>
            <BarChart3 style={{ width: "var(--sidepanel-icon-size)", height: "var(--sidepanel-icon-size)", color: "var(--color-muted)" }} />
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "var(--sidepanel-header-py) var(--sidepanel-header-px)", borderBottom: "var(--sidepanel-header-border)", background: "var(--sidepanel-header-bg)", fontSize: "var(--sidepanel-header-fs)", fontWeight: "var(--sidepanel-header-fw)", color: "var(--color-fg)" }}>
            <span>文件变更</span>
          </div>
          <div style={{ flex: 1, overflow: "hidden", padding: "var(--sidepanel-content-py) var(--sidepanel-content-px)", display: "flex", flexDirection: "column" }}>
            <PanelToolbar title="5 个文件">
              <PanelIconButton title="刷新">
                <RefreshCw style={{ width: "var(--sidepanel-btn-icon-size)", height: "var(--sidepanel-btn-icon-size)" }} />
              </PanelIconButton>
            </PanelToolbar>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sidepanel-row-gap)", marginTop: "4px" }}>
              <PanelRow active icon={<MessageSquare style={{ width: "14px", height: "14px", color: "var(--color-primary)", flexShrink: 0 }} />}>
                <span style={{ fontSize: "12px", color: "var(--color-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>src/main.ts</span>
              </PanelRow>
              <PanelRow icon={<MessageSquare style={{ width: "14px", height: "14px", color: "var(--color-muted)", flexShrink: 0 }} />}>
                <span style={{ fontSize: "12px", color: "var(--color-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>src/utils.ts</span>
              </PanelRow>
              <PanelRow icon={<MessageSquare style={{ width: "14px", height: "14px", color: "var(--color-muted)", flexShrink: 0 }} />}>
                <span style={{ fontSize: "12px", color: "var(--color-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>src/old.ts</span>
              </PanelRow>
            </div>
            <PanelSectionTitle>统计</PanelSectionTitle>
            <PanelStatRow label="输入 tokens" value={12345} />
            <PanelStatRow label="输出 tokens" value={5678} strong />
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
