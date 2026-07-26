// renderer UI 状态 —— shell 层的轻量 UI 状态(zustand)。
//
// 依据 docs/structure/17 §1.3.1(zustand 做 UI 状态)。这是 shell 细节,
// 不进圆心:主题 id、字号倍率、抽屉开关都是 UI 交互态,非业务契约。
// 后续接 electron-store 持久化 currentThemeId/fontScale(06 §7 偏好落点)。
import { create } from "zustand";

export interface UiState {
  /** 当前主题 id,决定 ThemeProvider 解析哪个主题 */
  currentThemeId: string;
  /** 字号倍率,1.0 = 主题原值;>1 放大、<1 缩小,覆盖 --font-size-* token */
  fontScale: number;
  /** 设置抽屉是否打开 */
  settingsOpen: boolean;
  setCurrentThemeId: (id: string) => void;
  setFontScale: (scale: number) => void;
  setSettingsOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  currentThemeId: "new-york-dark",
  fontScale: 1.0,
  settingsOpen: false,
  setCurrentThemeId: (id) => set({ currentThemeId: id }),
  setFontScale: (scale) => set({ fontScale: scale }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));
