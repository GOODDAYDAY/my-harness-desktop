// main 进程上下文契约 —— api/ipc 各注册器共享的依赖面。
// 契约声明在消费侧(api/ipc),bootstrap 负责组装实现并注入(依赖倒置)。
import type { JsonPrefsStore } from "../config/json-prefs";
import type { ConfigStore } from "../config/config-store";
import type { ModelCatalog } from "../models/model-catalog";
import type { PiSettingsApi, ModelsConfigApi, KernelModelsRegistry, KernelConfigApi } from "@my-harness-desktop/shared";
import type { KernelManager } from "../../kernel/core/kernel-manager";
import type { PluginRegistry } from "../loader/registry";
import type { SessionStore } from "../sessions/session-store";
import type { SessionBus } from "../sessions/session-bus";
import type { RestartCoordinatorImpl } from "../restart/restart-coordinator";
import type { KernelExtensionSource } from "@my-harness-desktop/shared";
import type { KernelId, KernelLogo, KernelVersionApi } from "@my-harness-desktop/shared";
import type { SkillAggregator } from "../skills/skill-aggregator";
import type { I18nResource } from "../i18n/merge";
import type { PluginLifecycleDeps } from "../lifecycle";

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
  /** 每个项目上次打开的会话(键=cwd,值=中立主键 ns;老会话无 ns 时回落投影路径)。
   *  导航状态,与 lastCwd 同域——各端独立导航,进不了多端同步白名单(SYNCED_PREF_KEYS)。
   *  写入时机是"成功打开/物化一个真实会话"(renderer 的 openSession / sessionStart 水合),
   *  不是"切走那一刻":这样才能保证冷启动恢复拿到的是退出时真正打开的会话。 */
  lastSessionByCwd: Record<string, string>;
  currentLocale: string;
  bundledSkillsEnabled: boolean;
  /** 自定义 pi 内核目录(docs/design/custom-cli-path.md):"" = 未设置,走数据根 > PATH 原链。 */
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
  lastSessionByCwd: {},
  currentLocale: "zh-CN",
  bundledSkillsEnabled: true,
  customCliDir: "",
  dshCustomCliDir: "",
};

/** main 进程全部路径,由 bootstrap 读取环境后注入;ipc 层不直读 process 环境。 */
export interface MainPaths {
  homeDir: string;
  myHarnessDesktopDir: string;
  configDir: string;
  generalConfigPath: string;
  bundledSkillsDir: string;
  bundledSkillsSource: string;
  builtinDir: string;
  userPluginsDir: string;
  projectPluginsDir: string;
  installedDir: string;
}

export interface MainContext {
  /** 各已注册内核的**配置根**（configFile 框架通道的白名单前缀）。
   *  从注册表收集而不是环境路径——加第四个内核自动纳入白名单，壳零改动。 */
  kernelConfigRoots: string[];
  /** 各已注册内核的**技能清单文件**（改它们 = 技能清单变了，壳据此重挂监视器）。
   *  技能清单存在哪是内核的私有知识（pi 在 settings.json，别的内核可能没有这个面）。 */
  kernelSkillWatchPaths: (cwd: string) => string[];
  paths: MainPaths;
  prefsStore: JsonPrefsStore<Prefs>;
  configStore: ConfigStore;
  modelCatalog: ModelCatalog;
  /** 内核模型配置中性 API(pi/dsh 各一个),bootstrap 组装注入。 */
  kernelModels: KernelModelsRegistry;
  /** 内核原生配置中性 API(pi/dsh 各一个,配置 TAB 用),bootstrap 组装注入。 */
  kernelConfig: Record<KernelId, KernelConfigApi>;
  /** 内核版本管理中性 API(每内核一个,从插件 registry 遍历 createVersionApi),bootstrap 组装注入。 */
  kernelVersionApis: Record<KernelId, KernelVersionApi>;
  /** 已注册内核 id 清单(运行时注册表顺序,替代 KERNEL_IDS 字面量数组)。 */
  kernelIds: KernelId[];
  registry: PluginRegistry;
  /** 技能聚合器(聚合 pi/dsh 的 SkillProvider),bootstrap 组装注入。 */
  skillAggregator: SkillAggregator;
  sessionStore: SessionStore;
  sessionBus: SessionBus;
  restartCoordinator: RestartCoordinatorImpl;
  /** 内核拓展源(按内核 id 作用域):pi/dsh 各一个,中性契约消费。 */
  kernelExtensions: Record<KernelId, KernelExtensionSource>;
  /** 内核身份标(logo)注册表:每个内核在自己适配器(client/{kernel})声明,壳经此渲染。 */
  kernelLogos: Record<KernelId, KernelLogo>;
  /** 一次性问内核能力(从 registry 遍历 createOneshot;pi 有、dsh/minimal 无 → undefined)。 */
  kernelOneshots: Record<KernelId, ((prompt: string, cwd?: string) => Promise<string>) | undefined>;
  /** 内置 skills 挂/摘(pi settings.json skills[];bootstrap 绑定实现)。 */
  ensureBundledSkills: (enabled: boolean) => Promise<boolean>;
  /** 插件技能挂/摘 hooks(pi settings.json skills[];bootstrap 绑定实现)。 */
  pluginSkillsEnsure: NonNullable<PluginLifecycleDeps["skillsEnsure"]>;
  /** 插件 pi 扩展挂/摘 hooks(client/pi;bootstrap 绑定实现)。 */
  /** 插件携带内核扩展的挂摘（按内核 id 派发；加第四个内核 = 它自己的插件交一份实现，本行不动）。 */
  pluginExtensionEnsure: NonNullable<PluginLifecycleDeps["pluginExtensionEnsure"]>;
  /** 插件 dsh cordis 扩展挂/摘 hooks(client/dsh;bootstrap 绑定实现)。 */
  i18n: {
    resources: I18nResource;
    namespaces: string[];
    supportedLngs: string[];
    localeList: { id: string; name: string }[];
  };
}
