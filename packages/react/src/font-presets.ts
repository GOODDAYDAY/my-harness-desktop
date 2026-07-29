// 字体选项 UI label + 字体栈(等宽字体/正文调性),供插件 renderer 渲染下拉/按钮。
// stack 字段来自 @pi-desktop/core 的 FONT_PRESETS 单源(评估 P2:此前双份契约,
// 现收敛到 domain/font-presets,本文件只补 UI label)。
// renderer 用 stack 渲染按钮预览(不再蹭全局 --font-family-* 变量,
// 切断"按钮字体被当前偏好反向驱动"的耦合)。
import { FONT_PRESETS } from "@pi-desktop/core";

export const MONO_CHOICES: { id: string; label: string; stack: string }[] = [
  { id: "jetbrains", label: "JetBrains Mono(优先)", stack: FONT_PRESETS.mono.jetbrains },
  { id: "fira", label: "Fira Code", stack: FONT_PRESETS.mono.fira },
  { id: "cascadia", label: "Cascadia Code", stack: FONT_PRESETS.mono.cascadia },
  { id: "sfmono", label: "SF Mono", stack: FONT_PRESETS.mono.sfmono },
  { id: "menlo", label: "Menlo", stack: FONT_PRESETS.mono.menlo },
  { id: "system", label: "系统等宽", stack: FONT_PRESETS.mono.system },
];

export const SANS_TONES: { id: string; label: string; stack: string }[] = [
  { id: "sans", label: "无衬线(默认)", stack: FONT_PRESETS.sans.sans },
  { id: "serif", label: "衬线", stack: FONT_PRESETS.sans.serif },
  { id: "mono", label: "等宽", stack: FONT_PRESETS.sans.mono },
  { id: "rounded", label: "圆润", stack: FONT_PRESETS.sans.rounded },
];
