// 设置页区块组件 —— 框架级"标题 + 说明 + 内容"统一排版契约。
//
// 供所有 settings 槽插件共用,避免每个插件各写一遍 <h2>+<p>+缩进(重复债)。
// 这是框架级样式契约:标题层级、说明文字调性、内容区缩进由本组件统一承担,
// 插件只填 title/description/children。属于"回调/重复结构应收进框架"的一例。
//
// 经 @pi-desktop/react 包导出,插件 import 本组件(依赖方向:插件 → react 包 → core)。
import type { ReactNode, CSSProperties } from "react";

export interface SettingsSectionProps {
  /** 区块标题(渲染为 h2)。 */
  title: string;
  /** 标题下灰色说明文字,可选。相对标题做层级缩进,体现"标题的附属说明"。 */
  description?: string;
  /** 区块内容。 */
  children?: ReactNode;
  /** 内容区额外样式(罕用,尽量不覆盖默认缩进)。 */
  style?: CSSProperties;
}

/**
 * 设置页区块:统一"标题 + 说明 + 内容"的缩进与层级。
 * - 说明文字相对标题缩进一段,表示是标题的附属说明(语义 B)。
 * - 内容区不额外缩进(由外层 settings-page 容器统一管外边距)。
 */
export function SettingsSection({ title, description, children, style }: SettingsSectionProps): ReactNode {
  return (
    <section style={style}>
      <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>{title}</h2>
      {description && (
        <p style={{ margin: "var(--spacing-xs) 0 0 var(--spacing-md)", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          {description}
        </p>
      )}
      {children && <div style={{ marginTop: "var(--spacing-md)" }}>{children}</div>}
    </section>
  );
}
