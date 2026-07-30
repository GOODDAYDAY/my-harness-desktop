// Button —— 框架级行动按钮(primary / secondary / danger + disabled)。
//
// 收敛动机:blind-review / pi-manager / pi-model-manager / skill-manager /
// plugin-manager / tool-manager 曾各自抄一份 btnStyle(primary, disabled)
// 工厂,差异仅参数级——同一逻辑多处复制(重复债),收敛为框架控件。
//
// 设计决策:
// - 禁用态消费 --color-disabled / --color-disabled-fg token,不再 opacity: 0.5
//   压色——半透明混色结果取决于父背景,主题无法定义"禁用色";现在禁用观感
//   本身就是主题内容。
// - lineHeight 固定(见 control-geometry):同行混放 Button/Select 高度恒等,
//   不再受 mono/sans 字体行高差影响。
// - 插件不手写按钮配色;自由排版/图标小方块请用 PanelIconButton 或原生 button。
import { useState, type CSSProperties, type ReactNode } from "react";
import { CONTROL_GEOMETRY } from "./control-geometry";

export type ButtonVariant = "primary" | "secondary" | "danger";

export interface ButtonProps {
  variant?: ButtonVariant;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  /** 布局覆盖(宽度、外边距等)。视觉契约(配色/圆角)不允许靠它绕过。 */
  style?: CSSProperties;
  title?: string;
  type?: "button" | "submit";
}

export function Button({ variant = "primary", disabled = false, onClick, children, style, title, type = "button" }: ButtonProps): ReactNode {
  const [hovered, setHovered] = useState(false);

  const visual: CSSProperties = disabled
    ? {
        background: "var(--color-disabled)",
        color: "var(--color-disabled-fg)",
        borderColor: "var(--color-border)",
        cursor: "not-allowed",
      }
    : {
        background:
          variant === "primary"
            ? "var(--color-primary)"
            : hovered && variant === "danger"
              // 注意:CSS 自定义属性名不允许点号——token key color.accent.error
              // 注入为 --color-accent-error;写成 var(--color-accent.error) 会静默失效
              // (存量插件有 14 处这个 bug,本次一并收敛)。
              ? "color-mix(in srgb, var(--color-accent-error) 12%, transparent)"
              : hovered
                ? "var(--color-surface)"
                : "transparent",
        color:
          variant === "primary"
            ? "var(--color-primary-fg)"
            : variant === "danger"
              ? "var(--color-accent-error)"
              : "var(--color-fg)",
        borderColor:
          variant === "primary"
            ? "var(--color-primary)"
            : variant === "danger"
              ? "var(--color-accent-error)"
              : "var(--color-border)",
        cursor: "pointer",
        // 只有 primary 用透明度做 hover 反馈(面性按钮压亮);描边按钮已有底色反馈
        opacity: hovered && variant === "primary" ? 0.9 : 1,
      };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...CONTROL_GEOMETRY,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--spacing-xs)",
        fontFamily: "var(--font-family-sans)",
        whiteSpace: "nowrap",
        flexShrink: 0,
        transition: "opacity var(--motion-duration-fast) var(--motion-ease-standard), background var(--motion-duration-fast) var(--motion-ease-standard)",
        ...visual,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
