// main 进程上下文契约 —— api/ipc 各注册器共享的依赖面。
// 契约声明在消费侧(api/ipc),bootstrap 负责组装实现并注入(依赖倒置)。
import type { JsonPrefsStore } from "../config/json-prefs";
import type { ConfigStore } from "../config/config-store";
import type { ModelCatalog } from "../models/model-catalog";
// ⚠ 此前这行还 import 了 `PiSettingsApi`——**死 import**（全文零使用）。它是 pi 专属存储面，
// 已下移到 `kernel/pi/manager/pi-settings-contract.ts`；壳只认中性 `KernelConfigApi`。
import type { ModelsConfigApi, KernelModelsApi, KernelConfigApi, KernelPluginReloadReport } from "@my-harness-desktop/shared";
import type { KernelOneshot } from "../../bootstrap/boot/kernel-accessors";

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
  // ⚠ 这里曾有 `customCliDir`（隐式 pi 的）与 `dshCustomCliDir` 两个字段——**按内核名分字段**，
  //   加第四个内核就要改这个中层类型（CLAUDE.md §6.3 检验④ 禁的形态），而且 `customCliDir`
  //   不带前缀＝"默认就是 pi"的残留特权（§1.4 要求显式化）。
  //   已移除：内核自定义目录属于**内核插件自定的 prefs 键**（圆心 `kernel-plugin.ts`：
  //   「核心不硬编码 key 名，key 由插件自定」），经 `JsonPrefsStore` 的动态键 API 读写，
  //   不进本接口。持久化格式不变（盘上仍是那两个键名，由各内核插件自己声明），
  //   所以无需迁移；未设置时读到 undefined，消费方本就按 falsy 处理。
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
  // ---- 注册表派生面：**函数形状**（boot-surface.md §3.6.3）----
  //
  // 为什么是函数而不是 Record/数组：这些面今天以**构造期快照**被持有，而 `MainContext` 的
  // 消费者里 **14 个 controller 文件有 10 个在注册时解构 `ctx`**——解构出的局部常量在内核插件
  // 重载后不会更新（`controllers/kernel.ts` 甚至同一个文件里两种模式并存：一半用解构量、
  // 一半直接读 `ctx.X`，所以只改一半的 handler 会 stale）。
  // 函数形状解决 stale 的机制很朴素：**函数引用在解构下是安全的**——
  // `const { kernelModels } = ctx` 拿到的是函数本身，调用它时才读注册表，因此永远新鲜。
  // 仓库里已有先例：`kernelSkillWatchPaths` 本来就是函数（本节唯一不需要改的字段）。
  //
  // ⚠ 新义务：per-id 访问器返回 `T | undefined`（显式缺面，不伪造）。今天的
  // `Record<KernelId, X>` 是 total 的，所以 `modelsApi(kernel).list()` 可以裸调；
  // 改形状后若不管，缺面会退化成 `TypeError: Cannot read properties of undefined`——
  // 那**不是可行动错误**。调用方必须显式处置：要么抛点名内核与面名的错误，要么跳过该内核
  // （遍历找"第一个有能力面的内核"那类路径本来就跳过，见 `llm:oneshot`）。

  /** 各已注册内核的**配置根**（configFile 框架通道的白名单前缀）。
   *  从注册表收集而不是环境路径——加第四个内核自动纳入白名单，壳零改动。 */
  kernelConfigRoots(): string[];
  /** 各已注册内核的**技能清单文件**（改它们 = 技能清单变了，壳据此重挂监视器）。
   *  技能清单存在哪是内核的私有知识（pi 在 settings.json，别的内核可能没有这个面）。 */
  kernelSkillWatchPaths: (cwd: string) => string[];
  paths: MainPaths;
  prefsStore: JsonPrefsStore<Prefs>;
  configStore: ConfigStore;
  modelCatalog: ModelCatalog;
  /** 内核模型配置中性 API(pi/dsh 各一个),bootstrap 组装注入。缺面 → undefined。 */
  kernelModels(kernel: KernelId): KernelModelsApi | undefined;
  /** 内核原生配置中性 API(pi/dsh 各一个,配置 TAB 用),bootstrap 组装注入。 */
  kernelConfig(kernel: KernelId): KernelConfigApi | undefined;
  /** 内核版本管理中性 API(每内核一个,从插件 registry 遍历 createVersionApi)。 */
  kernelVersionApi(kernel: KernelId): KernelVersionApi | undefined;
  /** 已注册内核 id 清单(运行时注册表顺序,替代 KERNEL_IDS 字面量数组)。 */
  kernelIds(): KernelId[];
  registry: PluginRegistry;
  /** 技能聚合器(聚合 pi/dsh 的 SkillProvider),bootstrap 组装注入。 */
  skillAggregator: SkillAggregator;
  sessionStore: SessionStore;
  sessionBus: SessionBus;
  restartCoordinator: RestartCoordinatorImpl;
  /** 内核拓展源(按内核 id 作用域):pi/dsh 各一个,中性契约消费。 */
  kernelExtensionSource(kernel: KernelId): KernelExtensionSource | undefined;
  /** 内核身份标(logo):来自 `KernelPlugin.logo`，壳经此渲染（不再有静态表）。
   *  ⚠ 走 last-known 语义：内核卸载后**本进程内曾在册**的 id 仍返回它的 logo——
   *  卸载注册表条目不 stop 已在跑的会话，那个会话确实跑在该内核上，图标不该消失
   *  （`boot/kernel-accessors.ts` 的 `logoOf`）。从未在册 → undefined，renderer 回落占位。 */
  kernelLogo(kernel: KernelId): KernelLogo | undefined;
  /** 一次性问内核能力(从 registry 遍历 createOneshot;pi 有、dsh/minimal 无 → undefined)。 */
  kernelOneshot(kernel: KernelId): KernelOneshot | undefined;
  /** **差量重载内核插件**（boot-surface.md §3.6.2 + §6.4.3 验收①）。
   *  实现会**两侧都收敛**：内核注册表（工厂/投影面/访问器缓存）与壳插件注册表
   *  （设置页 TAB、renderer、locales）——「一个内核 = 一个插件」，只动一侧会留下
   *  用户可见的半截状态。返回的组合报告分别说明两侧动了什么。
   *  ⚠ 这里暴露的是**一个函数**而不是整个 `KernelRuntimeState`：controller 只需要"触发重载、
   *  拿到变化清单"，不需要（也不该）拿到注册表/投影面/访问器去自己改。窄接口 = 少一处
   *  能绕过差量语义直接动注册表的口子。实现由 bootstrap 在 50-wiring 绑定。 */
  reloadKernelPlugins: () => Promise<KernelPluginReloadReport>;
  /** 内置 skills 挂/摘(内核 settings 的技能清单;bootstrap 绑定实现,逐内核遍历)。 */
  ensureBundledSkills: (enabled: boolean) => Promise<boolean>;
  /** **壳插件生命周期的驱动依赖**（§5.1.3 从 `controllers/plugins.ts` 上提到组装根）。
   *
   *  为什么上提：`lifecycle.activate`/`deactivate`（暖启动）与 `75-plugin-boot` 步骤（冷启动）
   *  要共用同一张操作表与同一个 `runOps`，也就必须共用同一份 `skillsEnsure` /
   *  `pluginExtensionEnsure` 实现。此前这两个实现由 bootstrap 构造、经 MainContext 的**两个散字段**
   *  交给 controller，controller 再现场拼一个 `PluginLifecycleDeps`——同一份依赖在两个层各建一次，
   *  这正是设计文档 §1.2.2 指出的"驱动依赖还在两个层各建一份"。现在组装根建一次、整体挂在
   *  MainContext 上，controller 直接取用。
   *
   *  ⚠ 此处曾是 `pluginSkillsEnsure` + `pluginExtensionEnsure` 两个字段（另带两条早已失去对应
   *  字段的孤儿注释："插件 pi 扩展挂/摘 hooks(client/pi)"、"插件 dsh cordis 扩展挂/摘
   *  hooks(client/dsh)"——那是按内核分字段时代的残留，字段中性化后注释没跟着走）。 */
  lifecycleDeps: PluginLifecycleDeps;
  i18n: {
    resources: I18nResource;
    namespaces: string[];
    supportedLngs: string[];
    localeList: { id: string; name: string }[];
  };
}
