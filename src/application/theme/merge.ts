// 主题合并 —— application 层用例编排(06 §2.2.2 buildCurrentTheme 的家)。
//
// 从 shell/renderer/theme-context 搬来:resolveTheme(递归 base + 环检测)、
// buildTheme(失败回退 THEME_TOKEN_DEFAULTS)、applyFontScale/applyFontChoice
// (用户偏好覆盖,在合并后注入层做)。
// 这是 application 层:依赖 domain + gateway(无),不依赖 shell/electron/react。
//
// 输入:themeId + 主题注册表(来自 loader/discover)+ 字体偏好。
// 输出:圆心 Theme(Record<string,string>,token key → 最终 CSS 值)。
import {
  THEME_TOKEN_DEFAULTS,
  type Theme,
} from "../../domain/slots/theme-tokens";
import type { ThemeContribution } from "../../domain/contributions";

/** 递归解析主题:取 base 的 token 打底,再用自身 tokens 覆盖。带环检测。 */
export function resolveTheme(
  themeId: string,
  registry: Record<string, ThemeContribution>,
  seen: Set<string> = new Set(),
): Theme {
  if (themeId === "__auto__") {
    // 动态 base:跟随系统明暗(本次简化为 dark;IPC 接入后替换,06 §7)
    themeId = "dark";
  }
  if (seen.has(themeId)) throw new Error(`循环继承: ${[...seen, themeId].join(" → ")}`);
  seen.add(themeId);
  const theme = registry[themeId];
  if (!theme) throw new Error(`主题不存在: ${themeId}`);
  const base = theme.base ? resolveTheme(theme.base, registry, seen) : {};
  return { ...THEME_TOKEN_DEFAULTS, ...base, ...theme.tokens };
}

/** 解析主题;失败回退默认值(06 §2.2.2 buildCurrentTheme 兜底语义)。 */
export function buildTheme(themeId: string, registry: Record<string, ThemeContribution>): Theme {
  try {
    return resolveTheme(themeId, registry);
  } catch {
    return { ...THEME_TOKEN_DEFAULTS };
  }
}

/** 等宽字体预设(覆盖 --font-family-mono,系统栈,零打包)。
 *  与 packages/react/src/font-presets.ts 的 MONO_CHOICES.stack 逐字一致(双份契约)。 */
export const MONO_PRESETS: Record<string, string> = {
  jetbrains: '"JetBrains Mono", "SF Mono", "Menlo", monospace',
  fira: '"Fira Code", "JetBrains Mono", monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", monospace',
  sfmono: '"SF Mono", "Menlo", monospace',
  menlo: '"Menlo", "Consolas", monospace',
  system: 'ui-monospace, "SF Mono", monospace',
};

/** 正文调性预设(覆盖 --font-family-sans,系统栈)。
 *  与 packages/react/src/font-presets.ts 的 SANS_TONES.stack 逐字一致(双份契约)。 */
export const SANS_PRESETS: Record<string, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  serif: 'Georgia, "Songti SC", "SimSun", serif',
  mono: '"SF Mono", "JetBrains Mono", "Menlo", "PingFang SC", monospace',
  rounded: '"SF Pro Rounded", "PingFang SC", "Microsoft YaHei", sans-serif',
};

/** 对 font.size.* token 应用字号倍率:把 "14px" → "14px" * scale。 */
export function applyFontScale(theme: Theme, scale: number): Theme {
  if (scale === 1.0) return theme;
  const out: Theme = { ...theme };
  for (const key of Object.keys(out)) {
    if (key.startsWith("font.size.")) {
      const m = out[key].match(/^([\d.]+)(px|rem|em)?$/);
      if (m) out[key] = `${Number(m[1]) * scale}${m[2] ?? "px"}`;
    }
  }
  return out;
}

/** 按字体选择覆盖 --font-family-mono/sans 的 CSS 变量(注入层,不改主题插件 token)。 */
export function applyFontChoice(
  theme: Theme,
  monoChoice: string,
  sansTone: string,
): Theme {
  const out: Theme = { ...theme };
  out["font.family.mono"] = MONO_PRESETS[monoChoice] ?? out["font.family.mono"];
  out["font.family.sans"] = SANS_PRESETS[sansTone] ?? out["font.family.sans"];
  return out;
}

/**
 * 合并入口:主题 + 字号倍率 + 字体选择 → 最终 Theme。
 * 对应 06 §2.2.2 buildCurrentTheme(本处精简,不含对比度校验/诊断收集,留演进)。
 */
export function buildCurrentTheme(
  themeId: string,
  registry: Record<string, ThemeContribution>,
  fontScale: number,
  fontMonoChoice: string,
  fontSansTone: string,
): Theme {
  const base = buildTheme(themeId, registry);
  const scaled = applyFontScale(base, fontScale);
  return applyFontChoice(scaled, fontMonoChoice, fontSansTone);
}
