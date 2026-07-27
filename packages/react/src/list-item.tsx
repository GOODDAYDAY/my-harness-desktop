// ListItem —— 框架级列表项组件(圆角框 + hover 高亮 + 选中态)。
//
// 供所有侧栏列表共用(会话列表/设置页左列表/命令面板等),避免每个组件各自
// 手写圆角+hover 逻辑(重复债)。框架级样式契约,插件 import 本组件。
import { useState, type ReactNode, type CSSProperties } from "react";

export interface ListItemProps {
  /** 是否选中(active)。选中时 surface 背景 + primary 边框。 */
  active?: boolean;
  /** 点击回调。 */
  onClick?: () => void;
  /** 内容。 */
  children?: ReactNode;
  /** 额外样式(罕用,尽量不覆盖默认圆角/hover)。 */
  style?: CSSProperties;
}

/**
 * 列表项:圆角框(radius-md)+ hover 高亮(surface 背景+border)+ 选中态。
 * - 非选中 hover:surface 背景 + border 高亮
 * - 选中:surface 背景 + primary 边框
 * - 过渡动画:background/border-color 0.15s
 */
export function ListItem({ active, onClick, children, style }: ListItemProps): ReactNode {
  const [hovered, setHovered] = useState(false);

  const bg = active ? "var(--color-surface)" : hovered ? "var(--color-surface)" : "transparent";
  const borderColor = active ? "var(--color-primary)" : hovered ? "var(--color-border)" : "transparent";
  const color = active ? "var(--color-fg)" : hovered ? "var(--color-fg)" : "var(--color-muted)";

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "var(--spacing-sm) var(--spacing-md)",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${borderColor}`,
        background: bg,
        color,
        cursor: "pointer",
        fontSize: "var(--font-size-base)",
        fontFamily: "var(--font-family-sans)",
        transition: "background 0.15s, border-color 0.15s, color 0.15s",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
