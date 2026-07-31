import { useState, type ReactNode } from "react";

export interface PanelTabsProps {
  tabs: { label: string; value: string }[];
  activeValue: string;
  onChange: (value: string) => void;
}

/** 下划线式 tab 页(设置页顶部语境):active 指示条咬住容器底边线,
 *   inactive hover 提亮;此前是药丸按钮组且蹭 sidepanel 变量(语境错配,字小不像 tab)。 */
export function PanelTabs({ tabs, activeValue, onChange }: PanelTabsProps): ReactNode {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: "var(--spacing-lg)",
        padding: "0 var(--spacing-xl)",
        borderBottom: "var(--divider-width) solid var(--divider-color)",
      }}
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.value}
          label={tab.label}
          active={tab.value === activeValue}
          onClick={() => onChange(tab.value)}
        />
      ))}
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): ReactNode {
  const [hover, setHover] = useState(false);
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "var(--spacing-sm) var(--spacing-xs)",
        marginBottom: "-1px",
        border: "none",
        borderBottom: `2px solid ${active ? "var(--color-primary)" : "transparent"}`,
        background: "transparent",
        color: active || hover ? "var(--color-fg)" : "var(--color-muted)",
        fontSize: "var(--font-size-base)",
        fontWeight: active ? 600 : 400,
        fontFamily: "var(--font-family-sans)",
        cursor: "pointer",
        transition:
          "color var(--motion-duration-fast) var(--motion-ease-standard), border-color var(--motion-duration-fast) var(--motion-ease-standard)",
      }}
    >
      {label}
    </button>
  );
}
