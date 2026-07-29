import { type ReactNode } from "react";

export interface PanelCardProps {
  children: ReactNode;
}

export function PanelCard({ children }: PanelCardProps): ReactNode {
  return (
    <div
      style={{
        padding: "var(--sidepanel-card-py) var(--sidepanel-card-px)",
        border: "var(--sidepanel-card-border)",
        borderRadius: "var(--sidepanel-card-radius)",
        boxShadow: "var(--sidepanel-card-shadow)",
        background: "var(--sidepanel-card-bg)",
      }}
    >
      {children}
    </div>
  );
}
