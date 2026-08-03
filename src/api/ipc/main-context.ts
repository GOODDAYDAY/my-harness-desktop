// main 进程上下文契约 —— api/ipc 各注册器共享的依赖面。
// 契约声明在消费侧(api/ipc),bootstrap 负责组装实现并注入(依赖倒置)。
import type Store from "electron-store";
import type { ConfigStore } from "../../core/application/config/config-store";
import type { PiSettingsStore } from "../../core/application/pi-settings/pi-settings-store";
import type { ModelsStore } from "../../core/application/models/models-store";
import type { PluginRegistry } from "../../core/application/loader/registry";
import type { SessionStore } from "../../core/application/sessions/session-store";
import type { SessionBus } from "../../core/application/sessions/session-bus";
import type { RestartCoordinatorImpl } from "../../core/application/restart/restart-coordinator";
import type { ExtensionStore } from "../../core/application/extensions/extension-store";
import type { I18nResource } from "../../core/application/i18n/merge";

// ---- 桌面偏好(electron-store):shell/store 管的偏好持久化 ----
// 主题 id/字号/字体是桌面偏好(06 §7:不进 pi settings、不进 plugins-data)。
// currentModelId 已迁出:有项目性质,住 general.json 分层文件(unified-project-config.md §5.4)。
export interface Prefs {
  currentThemeId: string;
  timelineThemeId: string;
  fontScale: number;
  fontMonoChoice: string;
  fontSansTone: string;
  sidebarStyle: string;
  sidepanelStyle: string;
  sidebarWidth: number;
  sidepanelWidth: number;
  timelineContentWidth: number;
  rightPanelOpen: boolean;
  activeSidePanelTabs: string[];
  lastCwd: string;
  currentLocale: string;
  bundledSkillsEnabled: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  currentThemeId: "chatgpt-dark",
  timelineThemeId: "__inherit__",
  fontScale: 1.0,
  fontMonoChoice: "jetbrains",
  fontSansTone: "sans",
  sidebarStyle: "default",
  sidepanelStyle: "default",
  sidebarWidth: 240,
  sidepanelWidth: 320,
  timelineContentWidth: 900,
  rightPanelOpen: false,
  activeSidePanelTabs: [],
  lastCwd: "",
  currentLocale: "zh-CN",
  bundledSkillsEnabled: true,
};

/** main 进程全部路径,由 bootstrap 读取环境后注入;ipc 层不直读 process 环境。 */
export interface MainPaths {
  homeDir: string;
  piDesktopDir: string;
  configDir: string;
  piInstallDir: string;
  piAgentDir: string;
  generalConfigPath: string;
  bundledSkillsDir: string;
  bundledSkillsSource: string;
  builtinDir: string;
  userPluginsDir: string;
  projectPluginsDir: string;
  installedDir: string;
}

export interface MainContext {
  paths: MainPaths;
  prefsStore: Store<Prefs>;
  configStore: ConfigStore;
  piSettingsStore: PiSettingsStore;
  modelsStore: ModelsStore;
  registry: PluginRegistry;
  sessionStore: SessionStore;
  sessionBus: SessionBus;
  restartCoordinator: RestartCoordinatorImpl;
  extensionStore: ExtensionStore;
  i18n: {
    resources: I18nResource;
    namespaces: string[];
    supportedLngs: string[];
    localeList: { id: string; name: string }[];
  };
}
