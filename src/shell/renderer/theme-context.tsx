// 主题注入:把 application 层合并好的 Theme 写成 CSS 变量,提供 React Context。
//
// 依据 docs/plugins/06 §4(注入段,renderer 侧落点)。
// 这是 shell 细节:圆心(domain)定 token key 清单,application/theme/merge
// 做合并,这里只负责把合并结果落到 CSS 变量 + 提供 React Context。
//
// 薄壳合规修复:不再直接 import 插件 manifest(改由 main 侧加载器发现,
// 经 window.pi.themes 受控 API 读);不再在 shell 跑合并算法(移到 application/theme/merge)。
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Theme } from "../../domain/slots/theme-tokens";
import { useUiStore } from "./ui-store";

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

/** 等宽字体下拉选项(id → 显示名,UI 表现,留 shell)。值映射在 application/theme/merge。 */
export const MONO_CHOICES: { id: string; label: string }[] = [
  { id: "jetbrains", label: "JetBrains Mono(优先)" },
  { id: "sfmono", label: "SF Mono" },
  { id: "menlo", label: "Menlo" },
  { id: "system", label: "系统等宽" },
];

/** 正文调性下拉选项。 */
export const SANS_TONES: { id: string; label: string }[] = [
  { id: "sans", label: "无衬线(默认)" },
  { id: "serif", label: "衬线" },
  { id: "mono", label: "等宽" },
];

/** 受控 pi API(preload 暴露的 window.pi 类型)。 */
interface PiApi {
  themes: {
    list: () => Promise<{ id: string; name: string }[]>;
    build: (themeId: string, fontScale: number, fontMono: string, fontSans: string) => Promise<Theme>;
  };
}
declare global {
  interface Window {
    pi: PiApi;
  }
}

// ---- React Context ----
interface ThemeContextValue {
  theme: Theme;
  themeId: string;
  /** 所有可选主题(异步从加载器读,初始空,加载完填)。 */
  themeOptions: { id: string; name: string }[];
}
const ThemeContext = createContext<ThemeContextValue | null>(null);

/** ThemeProvider:从 UI store 读主题/字体偏好,经 pi.themes.build 合并后注入 CSS 变量。 */
export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const themeId = useUiStore((s) => s.currentThemeId);
  const fontScale = useUiStore((s) => s.fontScale);
  const fontMonoChoice = useUiStore((s) => s.fontMonoChoice);
  const fontSansTone = useUiStore((s) => s.fontSansTone);
  const [theme, setTheme] = useState<Theme>({});
  const [themeOptions, setThemeOptions] = useState<{ id: string; name: string }[]>([]);

  // 启动时拉主题列表
  useEffect(() => {
    void window.pi.themes.list().then(setThemeOptions);
  }, []);

  // 主题/字体变化时重新合并 + 注入
  useEffect(() => {
    void window.pi.themes
      .build(themeId, fontScale, fontMonoChoice, fontSansTone)
      .then(setTheme);
  }, [themeId, fontScale, fontMonoChoice, fontSansTone]);

  // 注入 CSS 变量
  useEffect(() => {
    if (Object.keys(theme).length > 0) injectThemeCssVars(theme);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, themeId, themeOptions }),
    [theme, themeId, themeOptions],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}
