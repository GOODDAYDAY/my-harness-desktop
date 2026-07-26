// 设置页区块组件 —— 框架级"标题 + 说明 + 内容 + 圆角边框"统一排版契约。
//
// 供所有 settings 槽插件共用,避免每个插件各写一遍 <h2>+<p>+边框(重复债)。
// 这是框架级样式契约:标题层级、说明文字调性、内容区缩进、边框样式由本组件统一承担。
// 插件只填 title/description/children,缩进由本组件统一——避免每个插件各写一遍。
//
// 经 @pi-desktop/react 包导出,插件 import 本组件(依赖方向:插件 → react 包 → core)。
import type { ReactNode, CSSProperties } from "react";

export interface SettingsSectionProps {
  /** 区块标题(渲染为 h3)。 */
  title: string;
  /** 标题下灰色说明文字,可选。相对标题做层级缩进,体现"标题的附属说明"。 */
  description?: string;
  /** 区块内容。 */
  children?: ReactNode;
  /** 内容区额外样式(罕用,尽量不覆盖默认缩进)。 */
  style?: CSSProperties;
}

/**
 * 设置页区块:统一"标题 + 说明 + 内容"的缩进、层级与圆角边框。
 * - 圆角边框(border + radius-md,无填充背景,只有框)
 * - 标题顶格(h3),说明文字相对标题缩进(标题的附属)。
 * - 内容区(children)相对标题缩进 paddingLeft,体现"标题下的正文"层级。
 * 插件只填 title/description/children,样式由本组件统一。
 */
export function SettingsSection({ title, description, children, style }: SettingsSectionProps): ReactNode {
  return (
    <section style={{
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-md)",
      padding: "var(--spacing-md)",
      ...style,
    }}>
      <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{title}</h3>
      {description && (
        <p style={{ margin: "var(--spacing-xs) 0 0 var(--spacing-lg)", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          {description}
        </p>
      )}
      {children && <div style={{ marginTop: "var(--spacing-md)", paddingLeft: "var(--spacing-lg)" }}>{children}</div>}
    </section>
  );
}
