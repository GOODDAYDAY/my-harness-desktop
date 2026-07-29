import { type ReactNode } from "react";

export interface PanelTabsProps {
  tabs: { label: string; value: string }[];
  activeValue: string;
  onChange: (value: string) => void;
}

export function PanelTabs({ tabs, activeValue, onChange }: PanelTabsProps): ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-xs)", padding: "var(--sidepanel-toolbar-py) var(--sidepanel-toolbar-px)" }}>
      {tabs.map((tab) => {
        const isActive = tab.value === activeValue;
        return (
          <button
            key={tab.value}
            onClick={() => onChange(tab.value)}
            style={{
              padding: "var(--sidepanel-input-py) var(--sidepanel-input-px)",
              borderRadius: "var(--sidepanel-btn-radius)",
              border: isActive ? "var(--sidepanel-input-border-focus)" : "var(--sidepanel-input-border)",
              background: isActive ? "var(--sidepanel-btn-bg-hover)" : "var(--sidepanel-btn-bg)",
              color: isActive ? "var(--color-fg)" : "var(--color-muted)",
              fontSize: "var(--font-size-sm)",
              fontFamily: "var(--font-family-sans)",
              cursor: "pointer",
              transition: "background 0.15s, border-color 0.15s, color 0.15s",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
