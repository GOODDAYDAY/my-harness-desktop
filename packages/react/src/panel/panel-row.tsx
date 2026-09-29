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
  // r155：键盘焦点也能"揭示"操作区。此前只有 hovered 一条路（onMouseEnter/onMouseLeave），
  //   于是纯键盘用户 Tab 到这一行时**看不到也够不着**任何操作按钮——
  //   而这是骨架组件，影响面 = 所有用 PanelRow 带 actions 的插件（r154 查明并钉桩）。
  const [focused, setFocused] = useState(false);
  const bg = active ? "var(--sidepanel-row-bg-active)" : hovered ? "var(--sidepanel-row-bg-hover)" : "var(--sidepanel-row-bg)";
  const border = active ? "var(--sidepanel-row-border-active)" : hovered ? "var(--sidepanel-row-border-hover)" : "var(--sidepanel-row-border)";
  const shadow = active ? "var(--sidepanel-row-shadow-active)" : "var(--sidepanel-row-shadow)";
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // ⚠ 用 relatedTarget 判断焦点是否**离开本行**：焦点从行移到行内的操作按钮时会触发 blur，
      //   若无条件 setFocused(false)，按钮会在被点到的前一刻隐藏（点不中）。
      //   onFocus 不需要判断——React 的 focus 事件冒泡，子元素获得焦点时行的 onFocus 也会触发。
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sidepanel-row-gap)",
        padding: "var(--sidepanel-row-py) var(--sidepanel-row-px)",
        borderRadius: "var(--sidepanel-row-radius)",
        border,
        background: bg,
        boxShadow: shadow,
        backdropFilter: "var(--sidepanel-glass-blur, none)",
        cursor: onClick ? "pointer" : "default",
        transition: "background 0.15s, border-color 0.15s, box-shadow 0.15s",
      }}
    >
      {icon}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {/* r155：操作区**常驻 DOM**、只切可见性。
          此前是 `{hovered && …}` 条件渲染 ⇒ 未 hover 时按钮根本不在 DOM 里，
          键盘用户既看不到也 Tab 不到（可访问名普查也查不出来：元素不在 DOM）。
          现在改成 opacity 切换：元素始终可聚焦，聚焦时由 `focused` 揭示——
          这是标准的 "reveal on focus" 模式（不用 visibility:hidden，那会把元素移出 tab 序）。 */}
      {actions != null && (
        <span
          data-panel-row-actions=""
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-xs)",
            opacity: hovered || focused ? 1 : 0,
            transition: "opacity 0.15s",
          }}
        >
          {actions}
        </span>
      )}
    </div>
  );
}
