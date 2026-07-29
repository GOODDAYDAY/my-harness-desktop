import { useState, type ReactNode } from "react";

export interface PanelRowProps {
  active?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}

export function PanelRow({ active, onClick, icon, children, actions }: PanelRowProps): ReactNode {
  const [hovered, setHovered] = useState(false);
  const bg = active ? "var(--sidepanel-row-bg-active)" : hovered ? "var(--sidepanel-row-bg-hover)" : "var(--sidepanel-row-bg)";
  const border = active ? "var(--sidepanel-row-border-active)" : hovered ? "var(--sidepanel-row-border-hover)" : "var(--sidepanel-row-border)";
  const shadow = active ? "var(--sidepanel-row-shadow-active)" : "var(--sidepanel-row-shadow)";
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sidepanel-row-gap)",
        padding: "var(--sidepanel-row-py) var(--sidepanel-row-px)",
        borderRadius: "var(--sidepanel-row-radius)",
        border,
        background: bg,
        boxShadow: shadow,
        cursor: onClick ? "pointer" : "default",
        transition: "background 0.15s, border-color 0.15s, box-shadow 0.15s",
      }}
    >
      {icon}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {hovered && actions != null && (
        <span style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          {actions}
        </span>
      )}
    </div>
  );
}
