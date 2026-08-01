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
 * 七维度:颜色 / 字号字族 / 间距 / 圆角 / 阴影 / 运动 / 边框(06 §3.2-3.9)。
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
  // 禁用态控件对(对仗 color.primary / color.primary-fg):框架 Button/Select
  // 的 disabled 态只消费这两个 key——禁用视觉是主题内容,不再 opacity 压色
  // (半透明混色结果取决于父背景,主题无法控制)。
  // 不进 CONTRAST_PAIRS:WCAG §1.4.3 豁免非激活组件,禁用态本来就低强调。
  "color.disabled",
  "color.disabled-fg",
  // 外壳面背景(左栏 sidebar + 右面板 sidePanel):比主区略沉一层。
  // 三层背景语义:color.bg(主区) → color.chrome(外壳栏) → color.surface(卡片)。
  // 亮色由主题填干净浅灰(不再 mix black 出脏灰);暗色填压深值。
  "color.chrome",
  // 列表选中态(ListItem 框架级组件:会话列表/设置页左列表/命令面板共用)。
  // 选中底色 + 选中边框色,随主题走(本质是主题内容,不是桌面偏好)。
  // border 值 transparent = 无边框,色值 = 有边框;主题按各自气质填。
  "color.list.selected.bg",
  "color.list.selected.border",
  // 字号字族(06 §3.3)
  // xs 曾被遗忘:六个插件引用 var(--font-size-xs) 全部静默回落继承字号。
  // 收敛进契约(派生、随 fontScale 缩放),存量引用自动生效。
  "font.size.xs",
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
  // 运动(06 §3.8) —— 动画时长/缓动:主题可按气质覆盖节奏(终端快/深夜慢),
  // 不覆盖则用圆心默认值,框架动画只消费 var(--motion-*)。
  "motion.duration.fast",
  "motion.duration.normal",
  "motion.duration.slow",
  "motion.ease.standard",
  "motion.ease.emphasized",
  // 滚动条 —— 视觉常量,归主题 token:颜色/宽度/圆角全由主题填值,
  // 框架 index.css 只消费 var(--scrollbar-*)。形态(thin/pill/slim)= width+radius 值组合。
  "scrollbar.width",
  "scrollbar.radius",
  "scrollbar.thumb",
  "scrollbar.thumb.hover",
  // 分割线 —— 视觉常量,归主题 token:颜色/粗细/缩进全由主题填值,
  // 框架 sidebar 只消费 var(--divider-*)。用于左栏分组间可拖拽分割线:
  // 不同主题按各自底色定对比度与形态(细线/凹槽/虚线),不写死、不贯穿一色。
  "divider.color",
  "divider.width",
  "divider.inset",
  // 边框(06 §3.7)
  "border.width.thin",
  // 派生 token:在清单内(消费侧合法取值),但不应由插件显式赋值,
  // 由 application/theme/merge.ts 的 buildCurrentTheme 从 color.border 复制(06 §3.7)。
  "border.color",
] as const;

/** 派生 token 集合:显式赋值记警告并忽略,值由合并阶段自动派生。
 *  border.color ← color.border(06 §3.7);
 *  font.size.* ← 圆心默认值 × 用户 fontScale(06 §3.3:字号是用户偏好,主题不可设;
 *  主题能定义的是"文字样式"即 font.family.*)。 */
export const DERIVED_TOKENS: ReadonlySet<string> = new Set([
  "border.color",
  "font.size.xs",
  "font.size.base",
  "font.size.sm",
  "font.size.lg",
]);

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
  { fg: "color.fg", bg: "color.chrome" },
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
 * (06 §2.2.2 buildCurrentTheme 默认值补齐)。
 * 语义:这是"低保真兜底"——themeId 查无/主题插件损坏时防白屏用,不是 dark 主题的复制。
 * 与 dark 主题的精值无关(历史漂移:list.selected.bg/divider.color/divider.inset 已漂移 3 处,
 * 漂移根因是外层把"兜底"误读为"dark 复制",每改 dark 顺手抄错这里)。
 * 约定:不加新 token 值、不追对齐具体主题;缺 key 才用这里补,dark 该类主题值以主题插件为准。
 */
export const THEME_TOKEN_DEFAULTS: Theme = {
  "color.bg": "#0e0e11",
  "color.fg": "#e8e8eb",
  "color.surface": "#1b1b20",
  "color.surface-fg": "#e8e8eb",
  "color.primary": "#f5f5f7",
  "color.primary-fg": "#101013",
  "color.accent.success": "#4ac26b",
  "color.accent.warning": "#e5a63d",
  "color.accent.error": "#f2555a",
  "color.accent.danger": "#f2555a",
  "color.border": "#26262c",
  "color.muted": "#86868f",
  // 禁用态默认值:fg 10% 的淡底 + muted 字——明暗主题都协调(随主题 fg/muted 变)。
  "color.disabled": "color-mix(in srgb, var(--color-fg) 10%, transparent)",
  "color.disabled-fg": "var(--color-muted)",
  // 外壳面背景默认值:取暗色 mix(bg 70%, black) 的等价值,保持原侧栏观感。
  // 亮色主题由 plugin.json 覆盖为干净浅灰(原 mix 在白底上会出脏灰)。
  "color.chrome": "#0a0a0c",
  // 列表选中态默认值:底色沿用 surface(主题不填即跟 surface 协调),
  // 边框默认 transparent(无边框,靠底色区分选中)。主题按气质覆盖。
  "color.list.selected.bg": "var(--color-surface)",
  "color.list.selected.border": "transparent",
  "font.size.xs": "11px",
  "font.size.base": "14px",
  "font.size.sm": "12px",
  "font.size.lg": "16px",
  // 字族回退栈:各平台首选原生字体 + 中英文回退,零打包(第一步走系统字体)。
  // mono:代码/bash/diff,优先 JetBrains Mono(开发者常装),退到各平台原生等宽。
  // sans:正文 UI,Mac 用 SF、Win 用 Segoe UI,中文回退苹方/微软雅黑/思源黑体。
  "font.family.mono":
    '"SF Mono", "JetBrains Mono", "Menlo", "Consolas", "Microsoft YaHei", monospace',
  "font.family.sans":
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
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
  "border.color": "#26262c",
  // 阴影默认值取暗色主题的柔阴影(06 §3.6):近黑底上黑阴影不可见,
  // 靠更长扩散 + 边缘渐变制造层次,而非加深。
  "shadow.sm": "0 1px 2px rgba(0,0,0,0.5)",
  "shadow.md": "0 4px 12px rgba(0,0,0,0.5)",
  "shadow.lg": "0 12px 32px rgba(0,0,0,0.6)",
  // 滚动条默认值:细条悬浮风(中性白半透明 + 圆角,近黑底上低调)。
  // 主题不填即好看;填了是定制。hover 加深。
  "scrollbar.width": "10px",
  "scrollbar.radius": "6px",
  "scrollbar.thumb": "rgba(255,255,255,0.16)",
  "scrollbar.thumb.hover": "rgba(255,255,255,0.28)",
  // 分割线默认值:低对比细线 + 适度缩进(近黑底上若有若无)。
  // 颜色走 color-mix 从 border 派生(不写死色值,随主题 border 变);
  // 1px 细、左右各缩 8px 不顶满 → 有呼吸、不像接缝。主题不填即克制好看。
  "divider.color": "color-mix(in srgb, var(--color-border) 80%, transparent)",
  "divider.width": "1px",
  "divider.inset": "8px",
  // 运动默认值:三档时长 + 两条缓动(原 index.css 框架契约收编为主题 token,06 §3.8)。
  "motion.duration.fast": "120ms",
  "motion.duration.normal": "200ms",
  "motion.duration.slow": "300ms",
  "motion.ease.standard": "cubic-bezier(0.4, 0, 0.2, 1)",
  "motion.ease.emphasized": "cubic-bezier(0.22, 1, 0.36, 1)",
};
