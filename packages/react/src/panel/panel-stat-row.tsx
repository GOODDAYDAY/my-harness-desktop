import { type ReactNode } from "react";

export interface PanelStatRowProps {
  label: string;
  value: string | number;
  strong?: boolean;
}

export function PanelStatRow({ label, value, strong }: PanelStatRowProps): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "var(--sidepanel-stat-py) 0",
        fontSize: "var(--font-size-sm)",
      }}
    >
      <span style={{ color: "var(--color-muted)" }}>{label}</span>
      <span
        style={{
          fontFamily: "var(--font-family-mono)",
          color: "var(--color-fg)",
          fontWeight: strong ? 600 : 400,
        }}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
    </div>
  );
}
