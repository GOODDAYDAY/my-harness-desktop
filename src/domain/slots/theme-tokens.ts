// 主题 token 清单 —— 圆心拥有的稳定视觉契约。
//
// 依据 docs/plugins/06-plugin-theme.md §3、§4.1、§870。
// core 在此定义 token key 清单与默认值,主题插件(plugin.json contributes.themes)
// 给 key 填值;core 渲染时只认这些 key、不内嵌任何视觉常量。
//
// 零外部依赖:不 import react/electron/pi(圆心纯度纪律,structure/16 §10.1)。

/** token 清单语义版本,供插件 manifest 的 tokenSchemaVersion 兼容判定(06 §4.1.2)。 */
export const THEME_TOKEN_SCHEMA_VERSION = "1.0";

/**
 * 稳定 token key 清单。主题插件的 tokens 必须是这些 key 的子集
 * (派生 key 见 DERIVED_TOKENS,不应由插件显式赋值)。
 * 五维度:颜色 / 字号字族 / 间距 / 圆角 / 阴影 / 边框(06 §3.2-3.7)。
 */
export const THEME_TOKEN_KEYS = [
  // 颜色(06 §3.2)
  "color.bg",
  "color.fg",
  "color.surface",
  "color.surface-fg",
  "color.primary",
  "color.primary-fg",
  "color.accent.success",
  "color.accent.warning",
  "color.accent.error",
  "color.accent.danger",
  "color.border",
  "color.muted",
  // 字号字族(06 §3.3)
  "font.size.base",
  "font.size.sm",
  "font.size.lg",
  "font.family.mono",
  "font.family.sans",
  // 间距(06 §3.4)
  "spacing.xs",
  "spacing.sm",
  "spacing.md",
  "spacing.lg",
  "spacing.xl",
  // 圆角(06 §3.5)
  "radius.sm",
  "radius.md",
  "radius.lg",
  // 阴影(06 §3.6)
  "shadow.sm",
  "shadow.md",
  "shadow.lg",
  // 边框(06 §3.7)
  "border.width.thin",
  // 派生 token:在清单内(消费侧合法取值),但不应由插件显式赋值,
  // 由 application/theme/merge.ts 的 buildCurrentTheme 从 color.border 复制(06 §3.7)。
  "border.color",
] as const;

/** 派生 token 集合:显式赋值记警告并忽略,值由合并阶段自动派生(06 §3.7)。 */
export const DERIVED_TOKENS: ReadonlySet<string> = new Set(["border.color"]);

/** theme = token key → 最终 CSS 值字符串的扁平映射(圆心消费的唯一主题数据结构)。 */
export type Theme = Record<string, string>;

/** 必须校验 WCAG AA 对比度的颜色对(06 §3.2 末 + §870)。 */
export interface ContrastPair {
  fg: string; // token key
  bg: string; // token key
  largeText?: boolean; // 大字号 ≥3:1,否则 ≥4.5:1
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "color.fg", bg: "color.bg" },
  { fg: "color.surface-fg", bg: "color.surface" },
  { fg: "color.primary-fg", bg: "color.primary" },
  { fg: "color.muted", bg: "color.surface", largeText: true },
  { fg: "color.accent.success", bg: "color.surface" },
  { fg: "color.accent.warning", bg: "color.surface" },
  { fg: "color.accent.error", bg: "color.surface" },
  { fg: "color.accent.danger", bg: "color.surface" },
];

/**
 * token 默认值兜底。合并后缺失的 key 用这些值补齐,保证 Theme 永远含全部 key
 * (06 §2.2.2 buildCurrentTheme 默认值补齐)。取内置 dark 的值作默认(06 §4.2.1)。
 */
export const THEME_TOKEN_DEFAULTS: Theme = {
  "color.bg": "#1e1e2e",
  "color.fg": "#cdd6f4",
  "color.surface": "#313244",
  "color.surface-fg": "#cdd6f4",
  "color.primary": "#89b4fa",
  "color.primary-fg": "#1e1e2e",
  "color.accent.success": "#a6e3a1",
  "color.accent.warning": "#f9e2af",
  "color.accent.error": "#f38ba8",
  "color.accent.danger": "#f38ba8",
  "color.border": "#45475a",
  "color.muted": "#6c7086",
  "font.size.base": "14px",
  "font.size.sm": "12px",
  "font.size.lg": "16px",
  "font.family.mono": '"SF Mono", "JetBrains Mono", monospace',
  "font.family.sans": '-apple-system, "Segoe UI", sans-serif',
  "spacing.xs": "8px",
  "spacing.sm": "12px",
  "spacing.md": "16px",
  "spacing.lg": "24px",
  "spacing.xl": "32px",
  "radius.sm": "4px",
  "radius.md": "8px",
  "radius.lg": "12px",
  "border.width.thin": "1px",
  // border.color 为派生 token,默认值由 color.border 复制(06 §3.7)。
  "border.color": "#45475a",
  // 阴影默认值取暗色主题的柔阴影(06 §3.6)。
  "shadow.sm": "0 1px 3px rgba(0,0,0,0.3)",
  "shadow.md": "0 2px 8px rgba(0,0,0,0.4)",
  "shadow.lg": "0 8px 24px rgba(0,0,0,0.5)",
};
