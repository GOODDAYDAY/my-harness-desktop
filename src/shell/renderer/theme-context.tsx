// 主题注入:把圆心 Theme 对象的 token 写成 CSS 变量,并提供 React Context。
//
// 依据 docs/plugins/06-plugin-theme.md §4(注入段,renderer 侧落点)。
// 这是 shell 细节:圆心(domain)只定义 token key 清单,这里负责把它们
// 落到 CSS 变量上,让 pi.ui 组件用 var(--color-primary) 消费。
//
// 注意:真正的"加载器发现 + 槽位注册表 + buildCurrentTheme 合并 + base 继承"
// 是 application 层的后续工作。这里用一个精简的 resolveTheme(直接从
// plugin.json 的 contributes.themes 取 token + 递归 base)跑通可见链路。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  THEME_TOKEN_DEFAULTS,
  type Theme,
} from "../../domain/slots/theme-tokens";

/** token key → CSS 变量名:color.primary → --color-primary。 */
function tokenKeyToCssVar(key: string): string {
  return `--${key.replace(/\./g, "-")}`;
}

/** 把 Theme 写成 CSS 变量,挂到 element(默认 documentElement)上。 */
export function injectThemeCssVars(theme: Theme, element: HTMLElement = document.documentElement): void {
  for (const [key, value] of Object.entries(theme)) {
    element.style.setProperty(tokenKeyToCssVar(key), value);
  }
}

// ---- 精简主题解析(临时,等 application 层加载器落地后替换)----
// 直接 import 内置 + 三个风格插件的 plugin.json,按 currentThemeId 取 token,
// 递归 base 继承。不模拟"加载器发现"——这是验证可见链路的最小通路。
import builtinThemes from "../../plugins/theme/plugin.json";
import newYorkThemes from "../../plugins/theme-new-york/plugin.json";
import silentThemes from "../../plugins/theme-silent/plugin.json";
import stoneThemes from "../../plugins/theme-stone/plugin.json";

interface ThemeContribution {
  id: string;
  name: string;
  tokens: Record<string, string>;
  base?: string;
}

const ALL_THEMES: Record<string, ThemeContribution> = {};
function registerThemes(plugin: { contributes?: { themes?: ThemeContribution[] } }): void {
  for (const t of plugin.contributes?.themes ?? []) ALL_THEMES[t.id] = t;
}
registerThemes(builtinThemes);
registerThemes(newYorkThemes);
registerThemes(silentThemes);
registerThemes(stoneThemes);

/** 递归解析主题:取 base 的 token 打底,再用自身 tokens 覆盖。带环检测。 */
function resolveTheme(themeId: string, seen: Set<string> = new Set()): Theme {
  if (themeId === "__auto__") {
    // 动态 base:跟随系统明暗(本次简化为 dark;IPC 接入后替换,见 06 §7)
    themeId = "dark";
  }
  if (seen.has(themeId)) throw new Error(`循环继承: ${[...seen, themeId].join(" → ")}`);
  seen.add(themeId);
  const theme = ALL_THEMES[themeId];
  if (!theme) throw new Error(`主题不存在: ${themeId}`);
  const base = theme.base ? resolveTheme(theme.base, seen) : {};
  return { ...THEME_TOKEN_DEFAULTS, ...base, ...theme.tokens };
}

/** 解析主题;失败回退默认值(06 §2.2.2 buildCurrentTheme 兜底语义)。 */
export function buildTheme(themeId: string): Theme {
  try {
    return resolveTheme(themeId);
  } catch {
    return { ...THEME_TOKEN_DEFAULTS };
  }
}

// ---- React Context ----
interface ThemeContextValue {
  theme: Theme;
  themeId: string;
}
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ themeId, children }: { themeId: string; children: ReactNode }): ReactNode {
  const theme = useMemo(() => buildTheme(themeId), [themeId]);
  useMemo(() => injectThemeCssVars(theme), [theme]); // 注入副作用,挂载/主题变化时执行
  const value = useMemo<ThemeContextValue>(() => ({ theme, themeId }), [theme, themeId]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}
