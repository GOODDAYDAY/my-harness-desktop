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
  models: {
    get: <T>() => Promise<T>;
    set: <T>(config: T) => Promise<T>;
  };
  /** 用系统默认编辑器打开文件(框架"打开配置"按钮用)。 */
  openFile: (path: string) => Promise<void>;
  /** 通用 JSON 配置文件读写(框架级配置管理)。 */
  configFile: {
    get: (path: string) => Promise<Record<string, unknown>>;
    set: (path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace") => Promise<Record<string, unknown>>;
  };
  /** RPC 对接 pi 底座(支柱①)。 */
  rpc: {
    start: (cwd?: string) => Promise<{ ok: boolean }>;
    stop: () => Promise<{ ok: boolean }>;
    send: (command: unknown) => Promise<unknown>;
    resync: () => Promise<unknown>;
    onEvent: (cb: (event: unknown) => void) => () => void;
  };
  /** 会话文件扫描。 */
  sessions: {
    list: (cwd: string) => Promise<unknown[]>;
  };
  /** 对话框。 */
  dialog: {
    openDirectory: () => Promise<string | null>;
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
// ---- 设置页区块组件(框架级标题+说明+内容排版契约)----
export { SettingsSection, type SettingsSectionProps } from "./settings-section";
// ---- 列表项组件(圆角框+hover高亮+选中态,侧栏列表共用)----
export { ListItem, type ListItemProps } from "./list-item";

// ---- 设置页组件注册中心(移到本包,插件经此注册,非直连 shell)----
/** 设置页组件接受的 prop(框架驱动:框架管 config + dirty + save/reset)。 */
export interface SettingsComponentProps {
  /** 框架右上角刷新按钮触发 +1,组件 useEffect 依赖它重拉数据。 */
  refreshSignal: number;
  /** 框架持有的配置(从 manifest configFile 读了传入)。null=无 configFile(如 theme-manager)。 */
  config: Record<string, unknown> | null;
  /** 组件改值时调,框架更新 config state + 设 dirty。无 configFile 的插件不调。 */
  onChange: (config: Record<string, unknown>) => void;
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
