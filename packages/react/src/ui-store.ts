// renderer UI 状态 —— shell 层的轻量 UI 状态(zustand)+ 桌面偏好持久化。
//
// 依据 docs/structure/17 §1.3.1(zustand 做 UI 状态)+ 06 §7(主题/字体是桌面偏好,
// 走 electron-store,不进 pi settings、不进 plugins-data)。
// 这是 shell 细节:主题/字体偏好是 UI 交互态,非业务契约。
// 持久化:启动从 pi.prefs 读(经 main → electron-store),setter 调 pi.prefs.set 落盘,
// 跨重启保持(用户目标:不希望每次重启重新设置)。
import { create } from "zustand";

/** 主界面视图:对话页 / 设置页(整页覆盖) */
export type MainView = "chat" | "settings";

/** 等宽字体偏好(系统栈预设值,覆盖 --font-family-mono) */
export type FontMonoChoice = "jetbrains" | "fira" | "cascadia" | "sfmono" | "menlo" | "system";

/** 正文调性(覆盖 --font-family-sans) */
export type FontSansTone = "sans" | "serif" | "mono" | "rounded";

/** 桌面偏好持久化的字段集(与 main 的 Prefs 对齐)。 */
const PREF_KEYS = {
  currentThemeId: "currentThemeId",
  fontScale: "fontScale",
  fontMonoChoice: "fontMonoChoice",
  fontSansTone: "fontSansTone",
  rightPanelOpen: "rightPanelOpen",
  lastCwd: "lastCwd",
  currentLocale: "currentLocale",
  currentModelId: "currentModelId",
} as const;

export interface UiState {
  /** 当前主题 id,决定 ThemeProvider 解析哪个主题 */
  currentThemeId: string;
  /** 字号倍率,1.0 = 主题原值 */
  fontScale: number;
  /** 等宽字体偏好 */
  fontMonoChoice: FontMonoChoice;
  /** 正文调性 */
  fontSansTone: FontSansTone;
  /** 主界面视图 */
  mainView: MainView;
  /** 当前工作目录(pi 子进程的 cwd,决定会话在哪个桶) */
  currentCwd: string;
  /** 当前会话文件路径(switch_session 后更新) */
  currentSessionPath: string | null;
  /** 右面板是否展开(标题栏开关 + Cmd/Ctrl+J,落 prefs) */
  rightPanelOpen: boolean;
  /** 右面板当前页签 id(页签内容 keep-alive,刷新按可见性门控用) */
  activeSidePanelTab: string;
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
  bookmarkRequest: { requestId: string; sessionPath: string; entryId: string; preview: string } | null;
  setCurrentThemeId: (id: string) => void;
  setFontScale: (scale: number) => void;
  setFontMonoChoice: (choice: FontMonoChoice) => void;
  setFontSansTone: (tone: FontSansTone) => void;
  /** 切界面 locale:落 prefs + 通知 i18next changeLanguage(由调用方接 react-i18next) */
  setCurrentLocale: (locale: string) => void;
  /** 切模型:记偏好(落 prefs);pi 活着时由调用方再调 sessions.setModel 立即生效。 */
  setCurrentModelId: (id: string) => void;
  setCurrentThinkingLevel: (level: string) => void;
  setMainView: (view: MainView) => void;
  setCurrentCwd: (cwd: string) => void;
  setCurrentSessionPath: (path: string | null) => void;
  setRightPanelOpen: (open: boolean) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setActiveSidePanelTab: (id: string) => void;
  setSessionTitle: (title: string | null) => void;
  bumpSession: () => void;
  bumpPlugins: () => void;
  requestBookmark: (req: { sessionPath: string; entryId: string; preview: string }) => void;
  clearBookmarkRequest: () => void;
  hydrateFromPrefs: () => Promise<void>;
}

export const useUiStore = create<UiState>((set) => ({
  currentThemeId: "chatgpt-dark",
  fontScale: 1.0,
  fontMonoChoice: "jetbrains",
  fontSansTone: "sans",
  currentLocale: "zh-CN",
  currentModelId: null,
  currentThinkingLevel: null,
  mainView: "chat",
  currentCwd: "",
  currentSessionPath: null,
  rightPanelOpen: false,
  leftPanelOpen: true,
  activeSidePanelTab: "",
  sessionTitle: null,
  sessionNonce: 0,
  pluginsNonce: 0,
  hydrated: false,
  setCurrentThemeId: (id) => {
    set({ currentThemeId: id });
    void window.pi.prefs.set(PREF_KEYS.currentThemeId, id);
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
  setMainView: (view) => set({ mainView: view }),
  setCurrentCwd: (cwd) => {
    set({ currentCwd: cwd });
    void window.pi.prefs.set(PREF_KEYS.lastCwd, cwd);
  },
  setCurrentSessionPath: (path) => set({ currentSessionPath: path }),
  setRightPanelOpen: (open) => {
    set({ rightPanelOpen: open });
    void window.pi.prefs.set(PREF_KEYS.rightPanelOpen, open);
  },
  setLeftPanelOpen: (open) => set({ leftPanelOpen: open }),
  setActiveSidePanelTab: (id) => set({ activeSidePanelTab: id }),
  setSessionTitle: (title) => set({ sessionTitle: title }),
  bumpSession: () => set((s) => ({ sessionNonce: s.sessionNonce + 1 })),
  bumpPlugins: () => set((s) => ({ pluginsNonce: s.pluginsNonce + 1 })),
  bookmarkRequest: null,
  requestBookmark: (req) => set({ bookmarkRequest: { ...req, requestId: crypto.randomUUID() } }),
  clearBookmarkRequest: () => set({ bookmarkRequest: null }),
  hydrateFromPrefs: async () => {
    // electron-store 构造时已设 defaults(见 main 的 DEFAULT_PREFS),prefs.get 必返回值、
    // 不会是 undefined;故不需 ?? 兜底(盲审 F4:删死代码,承认 electron-store defaults 兜底)。
    const [currentThemeId, fontScale, fontMonoChoice, fontSansTone, rightPanelOpen, lastCwd, currentLocale, currentModelId] = await Promise.all([
      window.pi.prefs.get<string>(PREF_KEYS.currentThemeId),
      window.pi.prefs.get<number>(PREF_KEYS.fontScale),
      window.pi.prefs.get<string>(PREF_KEYS.fontMonoChoice),
      window.pi.prefs.get<string>(PREF_KEYS.fontSansTone),
      window.pi.prefs.get<boolean>(PREF_KEYS.rightPanelOpen),
      window.pi.prefs.get<string>(PREF_KEYS.lastCwd),
      window.pi.prefs.get<string>(PREF_KEYS.currentLocale),
      window.pi.prefs.get<string | null>(PREF_KEYS.currentModelId),
    ]);
    set({
      currentThemeId,
      fontScale,
      fontMonoChoice: fontMonoChoice as FontMonoChoice,
      fontSansTone: fontSansTone as FontSansTone,
      rightPanelOpen,
      // 恢复上次工作目录(经典桌面应用行为);main 侧 context 由 index.tsx hydration 后 startNewChat 同步
      currentCwd: lastCwd || "",
      currentLocale: currentLocale || "zh-CN",
      currentModelId: currentModelId ?? null,
      hydrated: true,
    });
  },
}));
