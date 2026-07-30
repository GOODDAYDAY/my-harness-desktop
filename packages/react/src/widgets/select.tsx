// Select —— 框架级下拉框,主题感知的原生 <select> 封装。
//
// 收敛动机:原生 <select> 的下拉箭头由 Chromium 绘制,颜色不随主题 token
// (暗色主题下箭头观感失真)。这里 appearance:none 抹掉原生镀铬,
// 用 lucide ChevronDown 自绘箭头——箭头随 token 走。
//
// 与 Button 共享 CONTROL_GEOMETRY:同一行混放时高度恒等,
// 不再受 mono/sans 字体行高差影响。
//
// 已知边界:展开后的 <option> 弹出层仍是 OS 原生渲染,不吃 CSS 变量。
// 彻底主题化需要自绘 listbox(无障碍/键盘交互成本高),显式标注演进,不做。
import type { CSSProperties, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { CONTROL_GEOMETRY } from "./control-geometry";

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 等宽字体(版本号、路径这类代码型内容)。 */
  mono?: boolean;
  children?: ReactNode;
  /** 布局覆盖(宽度等)。视觉契约(配色/圆角/箭头)不允许靠它绕过。 */
  style?: CSSProperties;
  ariaLabel?: string;
}

export function Select({ value, onChange, disabled = false, mono = false, children, style, ariaLabel }: SelectProps): ReactNode {
  // style 落在 wrapper(布局职责:宽度/伸缩),select 内部始终填满 wrapper。
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", flexShrink: 0, ...style }}>
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          ...CONTROL_GEOMETRY,
          appearance: "none",
          WebkitAppearance: "none",
          width: "100%",
          // 右侧为自绘箭头留位:右 padding = 按钮的水平 padding + 箭头宽 +
          // 箭头到文字的呼吸距,左 padding 与 Button 对齐观感。
          padding: `var(--spacing-xs) calc(var(--spacing-md) + 16px) var(--spacing-xs) var(--spacing-sm)`,
          borderColor: "var(--color-border)",
          background: disabled ? "var(--color-disabled)" : "var(--color-surface)",
          color: disabled ? "var(--color-disabled-fg)" : "var(--color-fg)",
          fontFamily: mono ? "var(--font-family-mono)" : "var(--font-family-sans)",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        style={{
          position: "absolute",
          right: "var(--spacing-sm)",
          pointerEvents: "none",
          color: disabled ? "var(--color-disabled-fg)" : "var(--color-muted)",
        }}
      />
    </span>
  );
}
