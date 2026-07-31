// renderer UI 状态 —— shell 层的轻量 UI 状态(zustand)+ 桌面偏好持久化。
//
// 依据 docs/structure/17 §1.3.1(zustand 做 UI 状态)+ 06 §7(主题/字体是桌面偏好,
// 走 electron-store,不进 pi settings、不进 plugins-data)。
// 这是 shell 细节:主题/字体偏好是 UI 交互态,非业务契约。
// 持久化:启动从 pi.prefs 读(经 main → electron-store),setter 调 pi.prefs.set 落盘,
// 跨重启保持(用户目标:不希望每次重启重新设置)。
import { create } from "zustand";
import { GENERAL_CONFIG_PATH } from "./paths";
import type { SidebarStyle, SidepanelStyle } from "./style-presets";

/** 主界面视图:对话页 / 设置页(整页覆盖)。
 *  评估 P1-C:原字段名 mainView 与"mainView 槽"(中区主视图槽)同名混淆,改 activeView。 */
export type AppView = "chat" | "settings";

/** 等宽字体偏好(系统栈预设值,覆盖 --font-family-mono) */
export type FontMonoChoice = "jetbrains" | "fira" | "cascadia" | "sfmono" | "menlo" | "system";

/** 正文调性(覆盖 --font-family-sans) */
export type FontSansTone = "sans" | "serif" | "mono" | "rounded";

/** 桌面偏好持久化的字段集(与 main 的 Prefs 对齐)。 */
const PREF_KEYS = {
  currentThemeId: "currentThemeId",
  timelineThemeId: "timelineThemeId",
  fontScale: "fontScale",
  fontMonoChoice: "fontMonoChoice",
  fontSansTone: "fontSansTone",
  sidebarStyle: "sidebarStyle",
  sidepanelStyle: "sidepanelStyle",
  sidebarWidth: "sidebarWidth",
  rightPanelOpen: "rightPanelOpen",
  activeSidePanelTabs: "activeSidePanelTabs",
  lastCwd: "lastCwd",
  currentLocale: "currentLocale",
  currentModelId: "currentModelId",
} as const;

export const SIDEBAR_MIN_PX = 180;
export const SIDEBAR_MAX_PX = 500;
export const SIDEBAR_DEFAULT_PX = 260;

const clampSidebarWidth = (px: number): number =>
  Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, Math.round(px)));

export interface UiState {
  /** 当前主题 id,决定 ThemeProvider 解析哪个主题 */
  currentThemeId: string;
  /** 会话流独立主题 id("__inherit__"=跟随全局) */
  timelineThemeId: string;
  /** 字号倍率,1.0 = 主题原值 */
  fontScale: number;
  /** 等宽字体偏好 */
  fontMonoChoice: FontMonoChoice;
  /** 正文调性 */
  fontSansTone: FontSansTone;
  /** 左栏风格 */
  sidebarStyle: SidebarStyle;
  /** 左栏宽度(px,会话页/设置页共享真相源:一边拖动,两边订阅同步) */
  sidebarWidth: number;
  /** 右面板风格 */
  sidepanelStyle: SidepanelStyle;
  /** 主界面视图(评估 P1-C:原 mainView,改名 activeView 避免与 mainView 槽混淆) */
  activeView: AppView;
  /** 当前工作目录(pi 子进程的 cwd,决定会话在哪个桶) */
  currentCwd: string;
  /** 当前会话文件路径(switch_session 后更新) */
  currentSessionPath: string | null;
  /** 右面板是否展开(标题栏开关 + Cmd/Ctrl+J,落 prefs) */
  rightPanelOpen: boolean;
  /** 右面板激活的面板 id 列表(最多 3 个同时可见,纵向堆叠) */
  activeSidePanelTabs: string[];
  /** 上次激活的 tabs(setRightPanelOpen(false) 时记,true 时恢复) */
  lastActiveSidePanelTabs: string[];
  /** 左栏是否展开(标题栏开关 + Cmd/Ctrl+B,会话内状态不持久化) */
  leftPanelOpen: boolean;
  /** 当前会话标题(面包屑用;null → "新对话") */
  sessionTitle: string | null;
  /** 会话世代号:newSession/切会话/切目录时 +1,timeline 依赖它重 resync */
  sessionNonce: number;
  /** 插件注册世代号:plugins-host 加载完成 +1,槽壳(sidebar/右面板/设置页)依赖它重渲染查组件 */
  pluginsNonce: number;
  /** 是否已从 prefs 加载完(初始 false,加载完 true,避免闪烁) */
  hydrated: boolean;
  /** 当前界面 locale(zh-CN/zh-TW/en/de),决定 i18next 查哪套文案 */
  currentLocale: string;
  /** 当前选中模型("provider/modelId" 形式);pi 没起时用此偏好显示,起 pi 后比对应用 */
  currentModelId: string | null;
  /** 当前思考强度偏好;pi 没起时用此显示,起 pi 后应用 */
  currentThinkingLevel: string | null;
  setCurrentThemeId: (id: string) => void;
  setTimelineThemeId: (id: string) => void;
  setFontScale: (scale: number) => void;
  setFontMonoChoice: (choice: FontMonoChoice) => void;
  setFontSansTone: (tone: FontSansTone) => void;
  setSidebarStyle: (style: SidebarStyle) => void;
  setSidebarWidth: (px: number) => void;
  setSidepanelStyle: (style: SidepanelStyle) => void;
  /** 切界面 locale:落 prefs + 通知 i18next changeLanguage(由调用方接 react-i18next) */
  setCurrentLocale: (locale: string) => void;
  /** 切模型:记偏好(落 prefs);pi 活着时由调用方再调 sessions.setModel 立即生效。 */
  setCurrentModelId: (id: string) => void;
  setCurrentThinkingLevel: (level: string) => void;
  setActiveView: (view: AppView) => void;
  setCurrentCwd: (cwd: string) => void;
  setCurrentSessionPath: (path: string | null) => void;
  setRightPanelOpen: (open: boolean) => void;
  setLeftPanelOpen: (open: boolean) => void;
  toggleSidePanelTab: (id: string) => void;
  setSessionTitle: (title: string | null) => void;
  bumpSession: () => void;
  bumpPlugins: () => void;
  hydrateFromPrefs: () => Promise<void>;
}

export const useUiStore = create<UiState>((set) => ({
  currentThemeId: "chatgpt-dark",
  timelineThemeId: "__inherit__",
  fontScale: 1.0,
  fontMonoChoice: "jetbrains",
  fontSansTone: "sans",
  sidebarStyle: "default",
  sidebarWidth: SIDEBAR_DEFAULT_PX,
  sidepanelStyle: "default",
  currentLocale: "zh-CN",
  currentModelId: null,
  currentThinkingLevel: null,
  activeView: "chat",
  currentCwd: "",
  currentSessionPath: null,
  rightPanelOpen: false,
  leftPanelOpen: false,
  activeSidePanelTabs: [],
  lastActiveSidePanelTabs: [],
  sessionTitle: null,
  sessionNonce: 0,
  pluginsNonce: 0,
  hydrated: false,
  setCurrentThemeId: (id) => {
    set({ currentThemeId: id });
    void window.pi.prefs.set(PREF_KEYS.currentThemeId, id);
  },
  setTimelineThemeId: (id) => {
    set({ timelineThemeId: id });
    void window.pi.prefs.set(PREF_KEYS.timelineThemeId, id);
  },
  setFontScale: (scale) => {
    set({ fontScale: scale });
    void window.pi.prefs.set(PREF_KEYS.fontScale, scale);
  },
  setFontMonoChoice: (choice) => {
    set({ fontMonoChoice: choice });
    void window.pi.prefs.set(PREF_KEYS.fontMonoChoice, choice);
  },
  setFontSansTone: (tone) => {
    set({ fontSansTone: tone });
    void window.pi.prefs.set(PREF_KEYS.fontSansTone, tone);
  },
  setSidebarStyle: (style) => {
    set({ sidebarStyle: style });
    void window.pi.prefs.set(PREF_KEYS.sidebarStyle, style);
  },
  setSidebarWidth: (px) => {
    const w = clampSidebarWidth(px);
    set({ sidebarWidth: w });
    void window.pi.prefs.set(PREF_KEYS.sidebarWidth, w);
  },
  setSidepanelStyle: (style) => {
    set({ sidepanelStyle: style });
    void window.pi.prefs.set(PREF_KEYS.sidepanelStyle, style);
  },
  setCurrentLocale: (locale) => {
    set({ currentLocale: locale });
    void window.pi.prefs.set(PREF_KEYS.currentLocale, locale);
  },
  setCurrentModelId: (id) => {
    set({ currentModelId: id });
    void window.pi.prefs.set(PREF_KEYS.currentModelId, id);
  },
  setCurrentThinkingLevel: (level) => {
    set({ currentThinkingLevel: level });
  },
  setActiveView: (view) => set({ activeView: view }),
  setCurrentCwd: (cwd) => {
    set({ currentCwd: cwd });
    void window.pi.prefs.set(PREF_KEYS.lastCwd, cwd);
  },
  setCurrentSessionPath: (path) => set({ currentSessionPath: path }),
  // 根因修复(G-20260201-01):原实现有两层嵌套的"tabs>0 即 return {}"守卫,
  // open=true 且 tabs 已激活时直接 return {}——不改 rightPanelOpen、不写 prefs,
  // 等于打开请求被吞掉。activeSidePanelTabs 与 rightPanelOpen 在 toggleSidePanelTab 里
  // 同生共死,此处不需要守卫:打开→恢复 lastActiveSidePanelTabs(无则空,壳会兜底激活第一个);
  // 关闭→清空后记住原 tabs 供下次恢复。路径单一,无守卫。
  setRightPanelOpen: (open) => set((s) => {
    if (open) {
      const tabs = s.activeSidePanelTabs.length > 0 ? s.activeSidePanelTabs : (s.lastActiveSidePanelTabs ?? []);
      void window.pi.prefs.set(PREF_KEYS.rightPanelOpen, true);
      void window.pi.prefs.set(PREF_KEYS.activeSidePanelTabs, tabs);
      return { rightPanelOpen: true, activeSidePanelTabs: tabs };
    }
    void window.pi.prefs.set(PREF_KEYS.rightPanelOpen, false);
    void window.pi.prefs.set(PREF_KEYS.activeSidePanelTabs, []);
    return { rightPanelOpen: false, activeSidePanelTabs: [], lastActiveSidePanelTabs: s.activeSidePanelTabs };
  }),
  setLeftPanelOpen: (open) => set({ leftPanelOpen: open }),
  toggleSidePanelTab: (id) => set((s) => {
    const tabs = s.activeSidePanelTabs;
    const next = tabs.includes(id) ? tabs.filter((t) => t !== id) : [...tabs, id];
    void window.pi.prefs.set(PREF_KEYS.activeSidePanelTabs, next);
    void window.pi.prefs.set(PREF_KEYS.rightPanelOpen, next.length > 0);
    return { activeSidePanelTabs: next, rightPanelOpen: next.length > 0 };
  }),
  setSessionTitle: (title) => set({ sessionTitle: title }),
  bumpSession: () => set((s) => ({ sessionNonce: s.sessionNonce + 1 })),
  bumpPlugins: () => set((s) => ({ pluginsNonce: s.pluginsNonce + 1 })),
  hydrateFromPrefs: async () => {
    // electron-store 构造时已设 defaults(见 main 的 DEFAULT_PREFS),prefs.get 必返回值、
    // 不会是 undefined;故不需 ?? 兜底(盲审 F4:删死代码,承认 electron-store defaults 兜底)。
    const [currentThemeId, fontScale, fontMonoChoice, fontSansTone, sidebarStyle, sidebarWidth, sidepanelStyle, rightPanelOpen, activeSidePanelTabs, lastCwd, currentLocale, currentModelId, timelineThemeId] = await Promise.all([
      window.pi.prefs.get<string>(PREF_KEYS.currentThemeId),
      window.pi.prefs.get<number>(PREF_KEYS.fontScale),
      window.pi.prefs.get<string>(PREF_KEYS.fontMonoChoice),
      window.pi.prefs.get<string>(PREF_KEYS.fontSansTone),
      window.pi.prefs.get<string>(PREF_KEYS.sidebarStyle),
      window.pi.prefs.get<number>(PREF_KEYS.sidebarWidth),
      window.pi.prefs.get<string>(PREF_KEYS.sidepanelStyle),
      window.pi.prefs.get<boolean>(PREF_KEYS.rightPanelOpen),
      window.pi.prefs.get<string[]>(PREF_KEYS.activeSidePanelTabs),
      window.pi.prefs.get<string>(PREF_KEYS.lastCwd),
      window.pi.prefs.get<string>(PREF_KEYS.currentLocale),
      window.pi.prefs.get<string | null>(PREF_KEYS.currentModelId),
      window.pi.prefs.get<string>(PREF_KEYS.timelineThemeId),
    ]);
    set({
      currentThemeId,
      fontScale,
      fontMonoChoice: fontMonoChoice as FontMonoChoice,
      fontSansTone: fontSansTone as FontSansTone,
      sidebarStyle: (sidebarStyle ?? "default") as SidebarStyle,
      sidebarWidth: clampSidebarWidth(sidebarWidth),
      sidepanelStyle: (sidepanelStyle ?? "default") as SidepanelStyle,
      rightPanelOpen,
      activeSidePanelTabs: Array.isArray(activeSidePanelTabs) ? activeSidePanelTabs : [],
      leftPanelOpen: (await window.pi.configFile.get(GENERAL_CONFIG_PATH))["sidebarDefaultOpen"] === true,
      currentCwd: lastCwd || "",
      currentLocale: currentLocale || "zh-CN",
      currentModelId: currentModelId ?? null,
      timelineThemeId: timelineThemeId || "__inherit__",
      hydrated: true,
    });
  },
}));
