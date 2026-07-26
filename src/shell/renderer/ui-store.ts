// renderer UI 状态 —— shell 层的轻量 UI 状态(zustand)。
//
// 依据 docs/structure/17 §1.3.1(zustand 做 UI 状态)。这是 shell 细节,
// 不进圆心:主题 id、字号倍率、主页面视图都是 UI 交互态,非业务契约。
// 后续接 electron-store 持久化 currentThemeId/fontScale(06 §7 偏好落点)。
import { create } from "zustand";

/** 主界面视图:对话页 / 设置页(整页覆盖) */
export type MainView = "chat" | "settings";

/** 等宽字体偏好(系统栈预设值,覆盖 --font-family-mono) */
export type FontMonoChoice = "jetbrains" | "sfmono" | "menlo" | "system";

/** 正文调性(覆盖 --font-family-sans) */
export type FontSansTone = "sans" | "serif" | "mono";

export interface UiState {
  /** 当前主题 id,决定 ThemeProvider 解析哪个主题 */
  currentThemeId: string;
  /** 字号倍率,1.0 = 主题原值;>1 放大、<1 缩小,覆盖 --font-size-* token */
  fontScale: number;
  /** 等宽字体偏好,覆盖 --font-family-mono */
  fontMonoChoice: FontMonoChoice;
  /** 正文调性,覆盖 --font-family-sans */
  fontSansTone: FontSansTone;
  /** 主界面视图:chat=对话页,settings=设置整页 */
  mainView: MainView;
  setCurrentThemeId: (id: string) => void;
  setFontScale: (scale: number) => void;
  setFontMonoChoice: (choice: FontMonoChoice) => void;
  setFontSansTone: (tone: FontSansTone) => void;
  setMainView: (view: MainView) => void;
}

export const useUiStore = create<UiState>((set) => ({
  currentThemeId: "new-york-dark",
  fontScale: 1.0,
  fontMonoChoice: "jetbrains",
  fontSansTone: "sans",
  mainView: "chat",
  setCurrentThemeId: (id) => set({ currentThemeId: id }),
  setFontScale: (scale) => set({ fontScale: scale }),
  setFontMonoChoice: (choice) => set({ fontMonoChoice: choice }),
  setFontSansTone: (tone) => set({ fontSansTone: tone }),
  setMainView: (view) => set({ mainView: view }),
}));
