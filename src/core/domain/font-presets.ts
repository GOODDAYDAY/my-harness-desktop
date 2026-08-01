// 圆心:内置字体预设契约 —— domain/font-presets,零外部依赖。
//
// 评估 P2:字体栈此前在 application/theme/merge.ts(MONO_PRESETS/SANS_PRESETS)和
// packages/react/src/font-presets.ts(MONO_CHOICES[].stack/SANS_TONES[].stack)双份
// 逐字重复(自标"双份契约"),易漂移。收敛到圆心单一源,两边 import。
//
// 字体栈是"会变的内容",严格 §2.2 应推给主题插件。当前阶段作为内置默认字体契约
// 放圆心(类比 THEME_TOKEN_DEFAULTS),未来若有"字体预设插件"槽再外推。
// label 是 UI 展示文案(随语言变),不放圆心,留在 packages/react 的 font-presets。
export const FONT_PRESETS = {
  mono: {
    jetbrains: '"JetBrains Mono", "SF Mono", "Menlo", monospace',
    fira: '"Fira Code", "JetBrains Mono", monospace',
    cascadia: '"Cascadia Code", "Cascadia Mono", monospace',
    sfmono: '"SF Mono", "Menlo", monospace',
    menlo: '"Menlo", "Consolas", monospace',
    system: 'ui-monospace, "SF Mono", monospace',
  } as Record<string, string>,
  sans: {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    serif: 'Georgia, "Songti SC", "SimSun", serif',
    mono: '"SF Mono", "JetBrains Mono", "Menlo", "PingFang SC", monospace',
    rounded: '"SF Pro Rounded", "PingFang SC", "Microsoft YaHei", sans-serif',
  } as Record<string, string>,
} as const;
