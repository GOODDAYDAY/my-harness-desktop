// 控件几何契约 —— Button / Select(及未来的 Input)共享的尺寸基线。
//
// 为什么独立成模块:框架控件必须同行等高。早年各插件手写控件时靠字体行高
// "碰运气"对齐(mono 与 sans 行高不同 → select 比 button 高 1-2px)。
// 收敛为单一来源:同一行里放再多控件,高度恒等。
//
// 只放几何(尺寸/行高/边框厚度),不放颜色——颜色是主题内容,在 token 里。
import type { CSSProperties } from "react";

export const CONTROL_GEOMETRY: CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-md)",
  borderWidth: "var(--border-width-thin)",
  borderStyle: "solid",
  borderRadius: "var(--radius-sm)",
  fontSize: "var(--font-size-sm)",
  // 统一行高:mixed 字体(mono select / sans button)同行等高。
  // 这就是当年各处对不齐的根——各控件行高取自不同字体的默认高度。
  lineHeight: 1.4,
};
