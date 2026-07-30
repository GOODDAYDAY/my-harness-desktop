import { useState, type ReactNode } from "react";

export interface PanelIconButtonProps {
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
}

export function PanelIconButton({ onClick, title, children, active, disabled, danger }: PanelIconButtonProps): ReactNode {
  const [hovered, setHovered] = useState(false);
  const bg = active
    ? "var(--sidepanel-btn-bg-hover)"
    : hovered
      ? danger
        ? "color-mix(in srgb, var(--color-accent-error) 10%, transparent)"
        : "var(--sidepanel-btn-bg-hover)"
      : "var(--sidepanel-btn-bg)";
  // disabled:文字色走 --color-disabled-fg token(与 Button/Select 同一禁用契约),
  // 不再 opacity 压色——混色结果依赖父背景,主题无法掌控。
  const color = disabled
    ? "var(--color-disabled-fg)"
    : active
      ? "var(--color-fg)"
      : danger
        ? "var(--color-accent-error)"
        : hovered
          ? "var(--color-fg)"
          : "var(--color-muted)";
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "var(--sidepanel-btn-size)",
        height: "var(--sidepanel-btn-size)",
        borderRadius: "var(--sidepanel-btn-radius)",
        border: "var(--sidepanel-btn-border)",
        background: bg,
        backdropFilter: "var(--sidepanel-glass-blur, none)",
        color,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}
