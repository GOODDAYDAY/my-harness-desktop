// @pi-desktop/react —— 插件 renderer 受控 API 包。
//
// 依据 docs/plugins/20-guide-extension.md:插件只 import @pi-desktop/react
// 拿受控 API,不直连 src/shell(守薄壳:plugins 不依赖 shell 内层)。
// 本包内部转发到 window.pi(经 preload 注入)+ 提供组件注册中心。
//
// 这是 H1 的真解:插件 import 本包,不直连 shell;包内部桥到 preload。
import type { ComponentType } from "react";
import type { Theme } from "@pi-desktop/core";

/** preload 暴露的 pi.* 受控 API 形状(与 preload.ts 暴露的一致)。 */
export interface PiApi {
  config: {
    get: <T>(pluginId: string, key: string) => Promise<T | undefined>;
    set: (pluginId: string, key: string, value: unknown) => Promise<void>;
    all: (pluginId: string) => Promise<Record<string, unknown>>;
  };
  prefs: {
    get: <T>(key: string) => Promise<T>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  themes: {
    list: () => Promise<{ id: string; name: string }[]>;
    build: (themeId: string, fontScale: number, fontMono: string, fontSans: string) => Promise<Theme>;
  };
  settings: {
    list: () => Promise<{ id: string; title: string; component: string; pluginId: string }[]>;
  };
  kernel: {
    status: () => Promise<{ currentVersion: string | null; available: boolean; error: string | null }>;
    listVersions: (forceRefresh?: boolean) => Promise<{ versions: string[]; latest: string | null }>;
    install: (
      version: string,
      onProgress: (line: string) => void,
      onDone: (r: { ok: boolean; error: string | null }) => void,
    ) => Promise<{ ok: boolean; error: string | null }>;
  };
  piSettings: {
    get: () => Promise<Record<string, unknown>>;
    set: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
    schema: () => Promise<{ key: string; type: string }[]>;
  };
}

/** window.pi 由 preload 注入,本包经此拿受控 API。 */
declare global {
  interface Window {
    pi: PiApi;
  }
}

/** 拿 preload 注入的受控 pi API。插件经此访问,不直连 shell。 */
export function usePiApi(): PiApi {
  return window.pi;
}

// ---- ui-store(桌面偏好状态,shell 和插件共用,本包持有真相源)----
export * from "./ui-store";
// ---- 字体选项 UI label(等宽/正文调性)----
export { MONO_CHOICES, SANS_TONES } from "./font-presets";

// ---- 设置页组件注册中心(移到本包,插件经此注册,非直连 shell)----
/**
 * 框架提供给插件的保存浮层句柄。插件 mount 时 register 自己的 save/reset,
 * 改值时 setDirty 报告脏态。框架读 dirty 渲染统一浮层,点确定/取消调 save/reset。
 */
export interface SaveBarApi {
  register(opts: { save: () => Promise<void>; reset: () => Promise<void> }): void;
  setDirty(dirty: boolean): void;
}

/** 设置页组件接受的 prop。 */
export interface SettingsComponentProps {
  /** 框架右上角刷新按钮触发 +1,组件 useEffect 依赖它重拉数据。 */
  refreshSignal: number;
  /** 框架提供的保存浮层句柄,插件注册 save/reset + 报告 dirty。 */
  saveBar: SaveBarApi;
}
const settingsComponents = new Map<string, ComponentType<SettingsComponentProps>>();

/** 插件 renderer 注册自己的配置页组件(按 component 名,settings 页按名查)。 */
export function registerSettingsComponent(name: string, comp: ComponentType<SettingsComponentProps>): void {
  settingsComponents.set(name, comp);
}

/** 按 component 名查配置页组件(供 settings-page 渲染)。 */
export function getSettingsComponent(name: string): ComponentType<SettingsComponentProps> | undefined {
  return settingsComponents.get(name);
}
