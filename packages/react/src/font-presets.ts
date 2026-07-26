// 字体选项 UI label + 字体栈(等宽字体/正文调性),供插件 renderer 渲染下拉/按钮。
// stack 字段是该选项的字体栈字面量,renderer 用它渲染按钮预览(不再蹭全局
// --font-family-* 变量,切断"按钮字体被当前偏好反向驱动"的耦合)。
// 值与 application/theme/merge.ts 的 MONO_PRESETS/SANS_PRESETS 逐字一致
// (发布面 vs 内部用,双份契约,演进时一并改——同 core/domain 双份模式)。
export const MONO_CHOICES: { id: string; label: string; stack: string }[] = [
  { id: "jetbrains", label: "JetBrains Mono(优先)", stack: '"JetBrains Mono", "SF Mono", "Menlo", monospace' },
  { id: "fira", label: "Fira Code", stack: '"Fira Code", "JetBrains Mono", monospace' },
  { id: "cascadia", label: "Cascadia Code", stack: '"Cascadia Code", "Cascadia Mono", monospace' },
  { id: "sfmono", label: "SF Mono", stack: '"SF Mono", "Menlo", monospace' },
  { id: "menlo", label: "Menlo", stack: '"Menlo", "Consolas", monospace' },
  { id: "system", label: "系统等宽", stack: 'ui-monospace, "SF Mono", monospace' },
];

export const SANS_TONES: { id: string; label: string; stack: string }[] = [
  { id: "sans", label: "无衬线(默认)", stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif' },
  { id: "serif", label: "衬线", stack: 'Georgia, "Songti SC", "SimSun", serif' },
  { id: "mono", label: "等宽", stack: '"SF Mono", "JetBrains Mono", "Menlo", "PingFang SC", monospace' },
  { id: "rounded", label: "圆润", stack: '"SF Pro Rounded", "PingFang SC", "Microsoft YaHei", sans-serif' },
];
