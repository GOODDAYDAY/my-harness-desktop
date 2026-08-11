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
import type { ThemeContribution, FontPresetContribution } from "../../domain/contributions";

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
 *  字体栈来自传入的 fontPresets 注册表(依赖倒置:内层声明"我需要按 id 查字体栈",
 *  数据源由外层装配注入)——字体栈是会变的内容,归插件贡献,merge 不 import 任何字体数据。
 *  mono 整体替换;查不到(偏好里存了已卸载插件贡献的 id)保留主题默认值。
 *  sans 双段拼接:英文段(拉丁字符)+ 中文段(汉字)+ generic(中文段的回落方向,
 *  三档兜底——偏好无效 id 也渲染出合法 font-family)。拼接是构造,在 merge 层;
 *  按字符逐段回退是执行,交给 CSS 引擎(构造在内、执行在外)。 */
export function applyFontChoice(
  theme: Theme,
  monoChoice: string,
  englishChoice: string,
  chineseChoice: string,
  fontPresets: Record<string, FontPresetContribution>,
): Theme {
  const out: Theme = { ...theme };
  const mono = fontPresets[monoChoice];
  if (mono) out["font.family.mono"] = mono.stack;
  const english = fontPresets[englishChoice];
  const chinese = fontPresets[chineseChoice];
  const englishStack = english?.stack ?? '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui';
  const chineseStack = chinese?.stack ?? '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"';
  const generic = chinese?.generic ?? "sans-serif";
  out["font.family.sans"] = `${englishStack}, ${chineseStack}, ${generic}`;
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
  fontEnglishChoice: string,
  fontChineseChoice: string,
  fontPresets: Record<string, FontPresetContribution>,
  systemDark = true,
): Theme {
  const base = buildTheme(themeId, registry, systemDark);
  const scaled = applyFontScale(base, fontScale);
  return applyFontChoice(scaled, fontMonoChoice, fontEnglishChoice, fontChineseChoice, fontPresets);
}
