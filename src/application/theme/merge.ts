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
  DERIVED_TOKENS,
  type Theme,
} from "../../domain/slots/theme-tokens";
import type { ThemeContribution } from "../../domain/contributions";
import { FONT_PRESETS } from "../../domain/font-presets";

/** 递归解析主题:取 base 的 token 打底,再用自身 tokens 覆盖。带环检测。
 *  派生 token(border.color/font.size.*)在此剥离——插件显式赋值一律忽略,
 *  字号只能来自圆心默认值 × fontScale(06 §3.3),border.color 由 color.border 派生。
 *  systemDark 由外层注入(application 不感知 OS):__auto__ 动态 base 按它分流 dark/light。 */
export function resolveTheme(
  themeId: string,
  registry: Record<string, ThemeContribution>,
  seen: Set<string> = new Set(),
  systemDark = true,
): Theme {
  if (themeId === "__auto__") {
    // 动态 base:跟随系统明暗(06 §7;值由 shell 经 nativeTheme 注入,见 buildCurrentTheme)
    themeId = systemDark ? "dark" : "light";
  }
  if (seen.has(themeId)) throw new Error(`循环继承: ${[...seen, themeId].join(" → ")}`);
  seen.add(themeId);
  const theme = registry[themeId];
  if (!theme) throw new Error(`主题不存在: ${themeId}`);
  const base = theme.base ? resolveTheme(theme.base, registry, seen, systemDark) : {};
  const own: Theme = {};
  for (const [k, v] of Object.entries(theme.tokens)) {
    if (!DERIVED_TOKENS.has(k)) own[k] = v;
  }
  return { ...THEME_TOKEN_DEFAULTS, ...base, ...own };
}

/** 解析主题;失败回退默认值(06 §2.2.2 buildCurrentTheme 兜底语义)。 */
export function buildTheme(
  themeId: string,
  registry: Record<string, ThemeContribution>,
  systemDark = true,
): Theme {
  try {
    return resolveTheme(themeId, registry, new Set(), systemDark);
  } catch {
    return { ...THEME_TOKEN_DEFAULTS };
  }
}

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

/** 按字体选择覆盖 --font-family-mono/sans 的 CSS 变量(注入层,不改主题插件 token)。
 *  字体栈来自 domain/font-presets 单源(评估 P2:此前双份契约)。 */
export function applyFontChoice(
  theme: Theme,
  monoChoice: string,
  sansTone: string,
): Theme {
  const out: Theme = { ...theme };
  out["font.family.mono"] = FONT_PRESETS.mono[monoChoice] ?? out["font.family.mono"];
  out["font.family.sans"] = FONT_PRESETS.sans[sansTone] ?? out["font.family.sans"];
  return out;
}

/**
 * 合并入口:主题 + 字号倍率 + 字体选择 → 最终 Theme。
 * 对应 06 §2.2.2 buildCurrentTheme。
 * systemDark:系统明暗,由 shell(nativeTheme.shouldUseDarkColors)注入,
 * 仅 __auto__ 动态 base 消费;对比度诊断见 application/theme/contrast.ts。
 */
export function buildCurrentTheme(
  themeId: string,
  registry: Record<string, ThemeContribution>,
  fontScale: number,
  fontMonoChoice: string,
  fontSansTone: string,
  systemDark = true,
): Theme {
  const base = buildTheme(themeId, registry, systemDark);
  const scaled = applyFontScale(base, fontScale);
  return applyFontChoice(scaled, fontMonoChoice, fontSansTone);
}
