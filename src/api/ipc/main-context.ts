// main 进程上下文契约 —— api/ipc 各注册器共享的依赖面。
// 契约声明在消费侧(api/ipc),bootstrap 负责组装实现并注入(依赖倒置)。
import type Store from "electron-store";
import type { ConfigStore } from "../../core/application/config/config-store";
import type { PiSettingsStore } from "../../core/application/pi-settings/pi-settings-store";
import type { ModelsStore } from "../../core/application/models/models-store";
import type { ModelCatalog } from "../../core/application/models/model-catalog";
import type { DshModelSource } from "../../client/dsh/dsh-model-source";
import type { PluginRegistry } from "../../core/application/loader/registry";
import type { SessionStore } from "../../core/application/sessions/session-store";
import type { SessionBus } from "../../core/application/sessions/session-bus";
import type { RestartCoordinatorImpl } from "../../core/application/restart/restart-coordinator";
import type { ExtensionStore } from "../../core/application/extensions/extension-store";
import type { I18nResource } from "../../core/application/i18n/merge";

// ---- 桌面偏好(electron-store):shell/store 管的偏好持久化 ----
// 主题 id/字号/字体是桌面偏好(06 §7:不进 pi settings、不进 plugins-data)。
export interface Prefs {
  currentThemeId: string;
  timelineThemeId: string;
  fontScale: number;
  fontMonoChoice: string;
  /** 正文字体偏好拆双维度:英文(拉丁字符段)/中文(汉字段),各自选各自家族的字体。 */
  fontEnglishChoice: string;
  fontChineseChoice: string;
  sidebarStyle: string;
  sidepanelStyle: string;
  sidebarWidth: number;
  sidebarFontScale: number;
  sidepanelFontScale: number;
  timelineFontScale: number;
  rightPanelOpen: boolean;
  activeSidePanelTabs: string[];
  /** 右面板图标条自定义排序(Strip 拖拽结果)。桌面 UI 偏好:全局生效,不分层——
   *  与 activeSidePanelTabs 同域(曾误落 general.json 项目级,按项目漂移,全局化迁回)。 */
  sidePanelOrder: string[];
  lastCwd: string;
  currentLocale: string;
  bundledSkillsEnabled: boolean;
  /** 自定义 pi 底座目录(docs/design/custom-cli-path.md):"" = 未设置,走数据根 > PATH 原链。 */
  customCliDir: string;
  /** 自定义 dsh 目录(与 customCliDir 同构,dsh CLI 入口 lib/bin.js):"" = 未设置。 */
  dshCustomCliDir: string;
}

export const DEFAULT_PREFS: Prefs = {
  currentThemeId: "chatgpt-dark",
  timelineThemeId: "__inherit__",
  fontScale: 1.0,
  fontMonoChoice: "jetbrains",
  fontEnglishChoice: "system",
  fontChineseChoice: "heiti",
  sidebarStyle: "default",
  sidepanelStyle: "default",
  sidebarWidth: 240,
  sidebarFontScale: 1.0,
  sidepanelFontScale: 1.0,
  timelineFontScale: 1.0,
  rightPanelOpen: true,
  activeSidePanelTabs: [],
  sidePanelOrder: [],
  lastCwd: "",
  currentLocale: "zh-CN",
  bundledSkillsEnabled: true,
  customCliDir: "",
  dshCustomCliDir: "",
};

/** main 进程全部路径,由 bootstrap 读取环境后注入;ipc 层不直读 process 环境。 */
export interface MainPaths {
  homeDir: string;
  piDesktopDir: string;
  configDir: string;
  piInstallDir: string;
  /** dsh 内核 npm 安装目录(~/.pi-desktop/dsh;dsh 配置另在 ~/.dsh 原生)。 */
  dshInstallDir: string;
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
  /** 当前生效的自定义底座 cli.js 绝对路径(读 prefs + resolveCustomCli 归一化;
   *  未设置/已失效返回 undefined → spawn 回落数据根 > PATH)。
   *  bootstrap 组装一次,SessionStore 与 kernel IPC 共用(单源,不各处自读 prefs)。 */
  customCliPath: () => string | undefined;
  configStore: ConfigStore;
  piSettingsStore: PiSettingsStore;
  modelsStore: ModelsStore;
  modelCatalog: ModelCatalog;
  dshModelSource: DshModelSource;
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
