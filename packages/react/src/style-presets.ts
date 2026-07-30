// 样式预设清单(契约) —— 左栏/右面板风格预设的唯一 TS 源。
//
// 单源纪律:样式内容(CSS vars)的唯一真源 = shell/renderer/index.css 的
// [data-sidebar-style|data-sidepanel-style="<id>"] 属性选择器块。
// 本文件只有清单契约(id + labelKey),不再持有任何样式值副本——
// 历史上 sidebar-styles.ts / panel-styles.ts / domain/panel-tokens.ts 的 vars map
// 与 index.css 的属性选择器块是同一概念的三处,已开始漂移
// (sidepanel.card.shadow: "none" vs "var(--shadow-sm)";domain defaults vs dark 主题 3 处漂移)。
//
// 新增一个样式 = ① index.css 加 [data-*-style="<id>"] 块 + ② 这里加 id + ③ i18n 加 labelKey key。
// 预览卡渲染挂 data attribute,与生产同一条 CSS 路径(漂移物理上不可能)。

/** 样式预设 id(左栏/右面板共用同一族值)。 */
export type StylePresetId = "default" | "card" | "minimal" | "outline" | "glass";

/** 兼容既有 import 名(type 移籍:原本分别在 sidebar-styles.ts / domain/panel-tokens.ts)。 */
export type SidebarStyle = StylePresetId;
export type SidepanelStyle = StylePresetId;

/** 样式预设清单项:id 是契约;labelKey 是 i18n key(文案 key 化,不再硬编码中文 label)。 */
export interface StylePreset {
  id: StylePresetId;
  /** i18n key(settings 桶),预览卡标签渲染 t(labelKey)。 */
  labelKey: string;
}

/** 左栏风格预设清单(契约:id + labelKey;样式内容唯一真源 = index.css 属性选择器块)。 */
export const SIDEBAR_STYLE_PRESETS: readonly StylePreset[] = [
  { id: "default", labelKey: "settings.style.default" },
  { id: "card", labelKey: "settings.style.card" },
  { id: "minimal", labelKey: "settings.style.minimal" },
  { id: "outline", labelKey: "settings.style.outline" },
  { id: "glass", labelKey: "settings.style.glass" },
];

/** 右面板风格预设清单(与左栏同一族值,独立清单是契约形状最直白的形式)。 */
export const SIDEPANEL_STYLE_PRESETS: readonly StylePreset[] = [
  { id: "default", labelKey: "settings.style.default" },
  { id: "card", labelKey: "settings.style.card" },
  { id: "minimal", labelKey: "settings.style.minimal" },
  { id: "outline", labelKey: "settings.style.outline" },
  { id: "glass", labelKey: "settings.style.glass" },
];

/** 便捷查表:id → 清单项。 */
export const SIDEBAR_STYLE_PRESET_MAP: Record<string, StylePreset> = Object.fromEntries(
  SIDEBAR_STYLE_PRESETS.map((p) => [p.id, p]),
);
export const SIDEPANEL_STYLE_PRESET_MAP: Record<string, StylePreset> = Object.fromEntries(
  SIDEPANEL_STYLE_PRESETS.map((p) => [p.id, p]),
);
