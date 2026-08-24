// main 进程上下文契约 —— api/ipc 各注册器共享的依赖面。
// 契约声明在消费侧(api/ipc),bootstrap 负责组装实现并注入(依赖倒置)。
import type Store from "electron-store";
import type { ConfigStore } from "../../core/application/config/config-store";
import type { ModelCatalog } from "../../core/application/models/model-catalog";
import type { DshConfigApi, PiSettingsApi, ModelsConfigApi, KernelModelsRegistry, KernelConfigApi } from "../../core/domain/context";
import type { KernelManager } from "../../core/application/kernel/kernel-manager";
import type { PluginRegistry } from "../../core/application/loader/registry";
import type { SessionStore } from "../../core/application/sessions/session-store";
import type { SessionBus } from "../../core/application/sessions/session-bus";
import type { RestartCoordinatorImpl } from "../../core/application/restart/restart-coordinator";
import type { KernelExtensionSource } from "../../core/domain/extensions";
import type { KernelId } from "../../core/domain/kernel";
import type { SkillAggregator } from "../../core/application/skills/skill-aggregator";
import type { I18nResource } from "../../core/application/i18n/merge";
import type { PluginLifecycleDeps } from "../../core/application/lifecycle";

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
  /** dsh API key 字面值按 provider 路由存(provider → key;spawn 时注入各 route 的 apiKeyEnv)。
   *  兼容旧单值 dshApiKey:迁移后 deepseek-official 落这里,其余 route 各自存。 */
  dshApiKeys: Record<string, string>;
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
  dshApiKeys: {},
};

/** main 进程全部路径,由 bootstrap 读取环境后注入;ipc 层不直读 process 环境。 */
export interface MainPaths {
  homeDir: string;
  myHarnessDesktopDir: string;
  configDir: string;
  piInstallDir: string;
  /** dsh 内核 npm 安装目录(~/.my-harness-desktop/dsh;dsh 配置另在 ~/.dsh 原生)。 */
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
  /** pi 底座 settings.json 中性面(bootstrap 绑定实现,含 .d.ts schema 解析)。 */
  piSettings: PiSettingsApi;
  /** pi 底座 models.json 中性面(bootstrap 绑定实现)。 */
  modelsConfig: ModelsConfigApi;
  modelCatalog: ModelCatalog;
  dshConfigSource: DshConfigApi;
  /** 内核模型配置中性 API(pi/dsh 各一个),bootstrap 组装注入。 */
  kernelModels: KernelModelsRegistry;
  /** 内核原生配置中性 API(pi/dsh 各一个,配置 TAB 用),bootstrap 组装注入。 */
  kernelConfig: Record<KernelId, KernelConfigApi>;
  /** pi 内核版本管理(装/查/自定义目录),bootstrap 组装注入。基类面,不依赖具体内核。 */
  piKernelManager: KernelManager;
  /** dsh 内核版本管理(装/查/自定义目录),bootstrap 组装注入。基类面,不依赖具体内核。 */
  dshKernelManager: KernelManager;
  registry: PluginRegistry;
  /** 技能聚合器(聚合 pi/dsh 的 SkillProvider),bootstrap 组装注入。 */
  skillAggregator: SkillAggregator;
  sessionStore: SessionStore;
  sessionBus: SessionBus;
  restartCoordinator: RestartCoordinatorImpl;
  /** 内核拓展源(按内核 id 作用域):pi/dsh 各一个,中性契约消费。 */
  kernelExtensions: Record<KernelId, KernelExtensionSource>;
  /** tool-gate 底座扩展可用性探测(pi 专属;bootstrap 绑定实现)。 */
  toolgateAvailable: () => boolean;
  /** 一次性问底座(llm:oneshot;pi 专属;bootstrap 绑定实现,cwd/cliPath 已闭包)。 */
  llmOneshot: (prompt: string) => Promise<string>;
  /** 内置 skills 挂/摘(pi settings.json skills[];bootstrap 绑定实现)。 */
  ensureBundledSkills: (enabled: boolean) => Promise<boolean>;
  /** 插件技能挂/摘 hooks(pi settings.json skills[];bootstrap 绑定实现)。 */
  pluginSkillsEnsure: NonNullable<PluginLifecycleDeps["skillsEnsure"]>;
  /** 插件 pi 扩展挂/摘 hooks(client/pi;bootstrap 绑定实现)。 */
  pluginPiExtensionEnsure: NonNullable<PluginLifecycleDeps["piExtensionEnsure"]>;
  /** 插件 dsh cordis 扩展挂/摘 hooks(client/dsh;bootstrap 绑定实现)。 */
  pluginDshExtensionEnsure: NonNullable<PluginLifecycleDeps["dshExtensionEnsure"]>;
  i18n: {
    resources: I18nResource;
    namespaces: string[];
    supportedLngs: string[];
    localeList: { id: string; name: string }[];
  };
}
