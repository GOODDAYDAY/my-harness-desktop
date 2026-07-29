import { type ReactNode } from "react";

export interface PanelSectionTitleProps {
  children: ReactNode;
}

export function PanelSectionTitle({ children }: PanelSectionTitleProps): ReactNode {
  return (
    <div
      style={{
        padding: "var(--sidepanel-section-py) var(--sidepanel-section-px)",
        fontSize: "var(--sidepanel-section-fs)",
        fontWeight: "var(--sidepanel-section-weight)",
        color: "var(--color-muted)",
      }}
    >
      {children}
    </div>
  );
}
