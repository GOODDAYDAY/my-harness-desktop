// 主题注入:把 application 层合并好的 Theme 写成 CSS 变量,提供 React Context。
//
// 依据 docs/plugins/06 §4(注入段,renderer 侧落点)。
// 这是 shell 细节:圆心(domain)定 token key 清单,application/theme/merge
// 做合并,这里只负责把合并结果落到 CSS 变量 + 提供 React Context。
//
// 薄壳合规修复:不再直接 import 插件 manifest(改由 main 侧加载器发现,
// 经 window.pi.themes 受控 API 读);不再在 shell 跑合并算法(移到 application/theme/merge)。
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Theme } from "@pi-desktop/contract";
import { eventBus } from "@pi-desktop/react";
import { useUiStore } from "./ui-store";

/** 系统明暗 tick:OS 主题翻转时 +1,作为 useEffect 依赖触发重 build
 *  (__auto__ 动态 base 的真实值在 main 侧 nativeTheme,renderer 不直读,事件驱动)。 */
function useSystemThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => eventBus.on("system:systemThemeChanged", () => setTick((n) => n + 1)), []);
  return tick;
}

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
  const systemThemeTick = useSystemThemeTick();

  // 启动时拉主题列表
  useEffect(() => {
    void window.pi.themes.list().then(setThemeOptions);
  }, []);

  // 主题/字体/系统明暗变化时重新合并 + 注入
  useEffect(() => {
    void window.pi.themes
      .build(themeId, fontScale, fontMonoChoice, fontSansTone)
      .then(setTheme);
  }, [themeId, fontScale, fontMonoChoice, fontSansTone, systemThemeTick]);

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

/**
 * 会话流独立主题作用域 —— 给 mainView 槽挂第二个主题实例。
 * 全局:ThemeProvider 把当前主题注入 documentElement 覆盖全局;
 * TimelineThemeScope 把 timelineThemeId 主题注入自己的子元素 ——
 * CSS 变量就近解析,只覆盖子树:左栏/右面板/标题栏/设置页不受影响。
 * timelineThemeId="__inherit__" 时不注入,子树级联回全局主题。 */
export function TimelineThemeScope({ children }: { children: ReactNode }): ReactNode {
  const timelineThemeId = useUiStore((s) => s.timelineThemeId);
  const fontScale = useUiStore((s) => s.fontScale);
  const fontMonoChoice = useUiStore((s) => s.fontMonoChoice);
  const fontSansTone = useUiStore((s) => s.fontSansTone);
  const systemThemeTick = useSystemThemeTick();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 跟随全局:仅清理 scoped 注入的 -- 前缀变量,保留 React 声明的 display:contents 骨架。
    // removeAttribute("style") 会把 display:contents 一并抹掉,wrapper 从裸元素变普通 block,
    // 布局链断裂 → ComposerDock 的 absolute bottom-0 相对塌缩后的容器,composer 位置漂移。
    // 根因:removeAttribute 清整个属性,React VDOM 不知情、不会重写,结构性声明永久丢失。
    if (!timelineThemeId || timelineThemeId === "__inherit__") {
      for (const name of [...el.style]) {
        if (name.startsWith("--")) el.style.removeProperty(name);
      }
      return;
    }
    void window.pi.themes
      .build(timelineThemeId, fontScale, fontMonoChoice, fontSansTone)
      .then((theme) => injectThemeCssVars(theme, el));
  }, [timelineThemeId, fontScale, fontMonoChoice, fontSansTone, systemThemeTick]);

  return <div ref={ref} style={{ display: "contents" }}>{children}</div>;
}
