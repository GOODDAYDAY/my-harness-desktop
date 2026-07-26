// 字体选项 UI label(等宽字体/正文调性),供插件 renderer 渲染下拉。
// 值映射在 application/theme/merge.ts(MONO_PRESETS/SANS_PRESETS),这里只给 UI label。
export const MONO_CHOICES: { id: string; label: string }[] = [
  { id: "jetbrains", label: "JetBrains Mono(优先)" },
  { id: "sfmono", label: "SF Mono" },
  { id: "menlo", label: "Menlo" },
  { id: "system", label: "系统等宽" },
];

export const SANS_TONES: { id: string; label: string }[] = [
  { id: "sans", label: "无衬线(默认)" },
  { id: "serif", label: "衬线" },
  { id: "mono", label: "等宽" },
];
