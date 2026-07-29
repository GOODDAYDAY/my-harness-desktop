import { type ReactNode } from "react";

export interface PanelToolbarProps {
  title?: ReactNode;
  children?: ReactNode;
}

export function PanelToolbar({ title, children }: PanelToolbarProps): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sidepanel-toolbar-gap)",
        padding: "var(--sidepanel-toolbar-py) var(--sidepanel-toolbar-px)",
        borderBottom: "var(--sidepanel-toolbar-border)",
        background: "var(--sidepanel-toolbar-bg)",
      }}
    >
      {title != null && <span style={{ flex: 1, minWidth: 0, fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{title}</span>}
      {children != null && <span style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexShrink: 0 }}>{children}</span>}
    </div>
  );
}
