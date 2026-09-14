// 圆心:内核插件契约 —— 一个可整体替换的内核实现 = 一个 KernelPlugin。
//
// 依据 docs/design/kernel-plugin.md。这是「内核插件化」的抽象面:核心(圆心 + 壳机制 + web 机制)
// 只认这一份接口,不认任何具体内核实现。每个内核(pi/dsh/minimal)在自己的插件目录里实现本接口,
// 经 KernelRegistry 运行时注册。加第四个内核 = 加一个插件 + 注册,核心零改动。
//
// 零依赖:本文件只 import 圆心内的类型,不 import 任何内核实现。

import type { BackendCreateOptions, BaseBackend, SeedOptions, SessionCatalog, KernelModelSource } from "./backend";
import type { NeutralEntry, NeutralSession } from "./session-neutral";
import type { KernelModelsApi, KernelConfigApi, KernelVersionApi } from "./context";
import type { KernelExtensionSource } from "./extensions";
import type { KernelId, KernelLogo } from "./kernel";
import type { SkillProvider } from "./skills";
import type { Question } from "./events/kernel-event";

/**
 * 内核插件上下文:壳启动时注入给内核插件工厂的运行时环境。内核插件的专属 spawn 参数
 * (cliPath/cordisConfig/agentDir/apiKey)由插件在工厂内从本上下文解析,不进 KernelPlugin 契约——
 * 契约只描述「内核能干什么」,不描述「内核怎么 spawn、参数从哪来」。
 * 字段按需扩展:阶段二 minimal 只需 isPackaged/homedir,阶段三 pi/dsh 迁移时补 prefs 等。
 */
export interface KernelPluginContext {
  /** 是否打包态(dev 读源码路径 / pkg 读 resources)。 */
  isPackaged: boolean;
  /** 用户主目录(~;minimal 的 agentDir 基于此)。 */
  homedir: string;
  /** 壳数据根(~/.my-harness-desktop 或 -dev);内核安装目录/版本管理从这推导。 */
  dataRoot: string;
  /** 偏好读写;内核插件读写自己的 customCliDir 等 key(核心不硬编码 key 名,key 由插件自定)。 */
  prefs: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void; remove(key: string): void };
  /** 模型连通性测试(内核 modelsApi 的 test 用);壳在装配点注入「绑定内核名」的 sessionStore.test 包装。
   *  中性回调,不暴露壳的 SessionStore 类型——依赖倒置:内核插件依赖「测模型」这个能力,壳提供实现。 */
  testModel: (cwd: string, provider: string, modelId: string) => Promise<{ ok: boolean; error?: string }>;
  /** 配置/内核变更时标记运行中会话重启(extension 的 onConfigChanged / version 的 setCustomCliDir 用)。 */
  markSessionsPendingRestart: (reason: string) => void;
  /** 内核安装/切换完成后的通用刷新信号(install 完成翻转 available 用)。 */
  broadcastRefresh: () => void;
  /** 内置 skills 资产目录(壳分发;pi 的 SkillProvider 扫描它)。 */
  builtinSkillsDir: string;
  /** 激活项目根(运行时变化;pi 的 SkillProvider 读项目级 settings.json / oneshot 用)。 */
  getCwd: () => string | null;
}

/**
 * 内核插件工厂:接收壳运行时环境,产出 KernelPlugin。bootstrap 装配点调用各内核的工厂,
 * 把返回的插件 register 进 KernelRegistry。加第四个内核 = 加一个工厂 + 在装配点调用它。
 */
export type KernelPluginFactory = (ctx: KernelPluginContext) => KernelPlugin;

/**
 * 内核插件的**面声明**：一个壳插件同时是一个内核插件时，在它自己的 manifest 里写的这一块。
 *
 * 「一个内核 = 一个插件」（§目标 11/13）落到物理形态上就是：内核本体与它的 desktop 对接面
 * 同属一个插件目录、共用一份 `plugin.json`。壳扫描壳插件根目录时，凡 manifest 带 `kernel` 块的
 * 即同时把它注册进 `KernelRegistry`；`enabled: false` 则**两面一起不装载**
 * （内核面不注册、对接面也不进壳插件清单——没有内核却显示它的设置页只会得到一堆报错）。
 *
 * 加第四个内核 = 加一个插件目录（含 `kernel` 块 + `renderer/`），核心零改动；
 * 卸载 = 删这一个目录，内核与它的设置页一起消失，其余内核照常。
 */
export interface KernelPluginManifest {
  /** 内核 id(单源：由宿主壳插件 manifest 的 `id` 提供，不在此重复声明)。 */
  id: KernelId;
  /**
   * 工厂模块入口。**缺省按约定定位**：壳把每个内核的工厂编译成
   * `<内核构建根>/<id>/plugin.js`（dev = `out/main/server/kernel/<id>/plugin.js`）。
   * 显式给出时才按它解析（相对宿主插件目录）——留给"不经构建、直接放一个 .js"的第三方内核。
   */
  factory?: string;
  /** 注册顺序(越小越先注册;只决定清单/展示次序——**不是「默认内核」**。壳不拿注册顺序当任何
   *  兜底:内核是模型的派生量,缺内核处显式报错,见设计原则 22)。缺省按字母序。 */
  order?: number;
  /** 默认装载开关(§目标 16):false = 默认不装载(随壳分发但默认关闭的内核)。
   *  缺省 true。运行时经 MHD_ENABLE_KERNELS 环境变量(逗号分隔内核 id)强制启用被声明为 off
   *  的内核;加载器经 defaultEnabledEntries 按此过滤,不硬编码任何内核名。
   *
   *  注意:这个开关**只能启用"在场的插件"**——插件不在扫描根里(如测试专用插件)时,环境变量
   *  什么也启用不了。minimal 曾靠它在本不存在的场合被启用,从而在真实项目里留下过用户看不懂的
   *  会话(幽灵行);现在 minimal 摘出内置目录后,这条路径在结构上不可达。 */
  enabled?: boolean;
}

/**
 * 内核插件工厂模块的导出形状:default 导出工厂(ESM),或按 id 命名导出(兼容)。
 * 加载器先取 default,再回落 `${id}KernelPlugin` 命名导出。
 */
export interface KernelPluginModule {
  default?: KernelPluginFactory;
  [name: string]: unknown;
}

/**
 * 内核插件:一个内核的完整适配器集合(会话面 + 目录面 + 管理面)。
 *
 * 会话面(createBackend/seed)替代旧 BackendFactory 的「按 opts.kernel 三分支」路由——
 * 每个插件自己负责 spawn/seed,核心经注册表按 id 查插件、调其 createBackend/seed。
 * 专属 spawn 参数(cliPath/cordisConfig/apiKey)由插件在实现内部自行解析(经构造时闭包捕获),
 * 不进本契约——契约只描述「内核能干什么」,不描述「内核怎么 spawn」。
 */
export interface KernelPlugin {
  /** 内核 id(插件声明,核心不硬编码)。 */
  readonly id: KernelId;

  /** 内核身份标 logo(壳做通用渲染,不硬编码任何内核的 logo path)。 */
  readonly logo: KernelLogo;

  /** 建一个内核后端(BaseBackend)。opts 是中性 BackendCreateOptions;专属参数插件内部解。 */
  createBackend(opts: BackendCreateOptions): BaseBackend;

  /**
   * 预 seed:在 spawn 之前产出目标内核的会话标识。语义同 BackendFactory.seed(§4.5):
   * - 文件态内核(pi/minimal)= 纯文件写,先 seed 得路径再以该路径 spawn;
   * - RPC 内核(dsh)= 依赖进程,返回 null,走 create → start → backend.seed。
   */
  seed?(lineage: NeutralEntry[], opts: SeedOptions & { kernel: KernelId; cwd: string }): Promise<string | null>;

  /** 建会话目录/CRUD 面(per-kernel 跨会话存储)。agentDir 是插件自己的数据根,工厂闭包捕获。 */
  createCatalog(): SessionCatalog;

  // ---- 管理面五槽位(§7.9 诚实实现/诚实桩都由插件自己交) ----

  /** 模型清单源(模型下拉合流用)。 */
  createModelSource(): KernelModelSource;

  /** 模型配置 API(设置页模型 TAB)。 */
  createModelsApi(): KernelModelsApi;

  /** 原生配置 API(设置页配置 TAB)。 */
  createConfigApi(): KernelConfigApi;

  /** 扩展源(设置页扩展 TAB)。 */
  createExtensionSource(): KernelExtensionSource;

  /** 版本管理 API(设置页内核版本 TAB)。内置内核可交「不支持安装」的诚实桩。 */
  createVersionApi(): KernelVersionApi;

  /** 一次性问内核(llm:oneshot 能力;pi 专属,dsh/minimal 无此面)。缺省 undefined = 无此面,
   *  壳经「有则用、无则降级」探测。cwd = 激活项目根(调用方注入,运行时变化,不进插件 ctx)。 */
  createOneshot?(): (prompt: string, cwd?: string) => Promise<string>;

  /** 技能能力面(内核各自读自己的存储、回报;壳的 SkillAggregator 聚合它们,不读内核存储)。
   *  缺省 undefined = 无 skill 面。 */
  createSkillProvider?(): SkillProvider;

  /** 扩展同步能力(dsh 专属:壳插件携带 dsh-extension → 同步目录 + 挂 cordis.yml 块)。
   *  缺省 undefined = 无此面。壳的 lifecycle 钩子 + 启动 syncFit/reconcile 经此委托给插件。 */
  /**
   * **壳插件携带的内核扩展**的同步面（neutral：不叫 piExtensionEnsure / dshExtensionEnsure）。
   *
   * 壳插件可以在自己目录里带一份"给某个内核补能力"的扩展（pi 的 TS 扩展、dsh 的 Cordis 插件），
   * 并在 manifest 的 `extensions` 里声明 `{ 内核 id: 相对路径 }`。框架在插件启停时把这件事
   * 转交给**对应内核的**同步实现——就是本方法。每个内核各交一份，壳遍历注册表按 id 派发，
   * 圆心与生命周期层零内核名（加第四个内核只写它自己这一份）。
   *
   * 与 `createLifecycle().skillsEnsure` 的区别：那个是"内核自己的 skills 注册表"（pi 专属面），
   * 这个是"别的插件的私货怎么进内核的扩展位"——是**同步机制**，每个内核都必须能兑现。
   */
  createPluginExtensionSync?(): {
    onActivate(pluginId: string, pluginPath: string, extensionDir: string): void;
    onDeactivate(pluginId: string): void;
    /**
     * 随壳分发的"**适配扩展**"（非壳插件携带，是壳自带的）的启动同步；无此形态的内核缺省 undefined。
     * **不接参数**：资产路径与它在内核侧的注册 id 都是该内核的私有知识（"我们的适配扩展放在哪"
     * 这件事，壳不该知道），由插件自己从 `ctx.isPackaged` 解析——与 cliPath/agentDir 同一套做法。
     * 返回它在系统里注册的 id（供壳并入对账的 active 集合）；未装返回 null。
     */
    syncFit?(): string | null;
    /** 冷启动对账：摘除已不在场的插件的扩展目录（缺省 undefined = 不做对账）。 */
    reconcile?(activeIds: ReadonlySet<string>): void;
  };

  /** 提问桥能力(dsh 专属:监听问句目录 → 投中性提问事件)。缺省 undefined = 无此面。
   *  壳经 onQuestion 订阅,把提问汇入统一通道(sessionStore.injectQuestion)。 */
  createQuestionBridge?(): {
    start(): void;
    onQuestion(cb: (req: { requestId: string; sessionId: string; questions: Question[] }) => void): () => void;
  };

  /**
   * 该内核**会话文件所在的根目录**（pi: `<agentDir>/sessions`；dsh: 数据根下的 dsh/sessions；
   * minimal: `<agentDir>/sessions`）。壳用它做两件事：① 判断一个路径"是不是内核会话文件"
   * （总线 `session_reopen` 的路径圈禁，越界会把任意文件读进会话上下文）；
   * ② 排除工作区扫描。缺省 undefined = 该内核不落文件（无路径可圈）。
   *
   * 为什么由内核交而不是壳算：会话根是**内核的存储私有知识**（dsh 的根还带 cwd 分桶与 lineage
   * 子目录），壳只需要"某个前缀是不是内核会话区"这个判断所需的最小事实。
   * 历史上壳里硬编码过 `~/.pi/agent`（PI_AGENT_DIR），于是「哪些路径算内核会话区」
   * 只在 pi 上成立，别的内核的会话文件不受同一道门保护。
   */
  sessionRoot?(): string;

  /**
   * 该内核的**配置根目录**（pi: `~/.pi/agent`；dsh: `~/.dsh`；minimal: `~/.minimal/agent`）。
   * 壳用它做 `configFile` 框架通道的**白名单前缀**（防止任意路径读写）。
   * 此前壳里写死 `~/.pi/agent`，于是"能被框架通道读写的只有 pi 的配置区"——
   * 别的内核的配置文件反而打不开、而这份白名单看起来又像"通用安全策略"。
   */
  configRoot?(): string;

  /**
   * 该内核**技能清单所在文件**（改这些文件 = 技能清单变了，壳据此重扫）。
   * 技能清单存在哪是内核的私有知识（pi 在 `settings.json` 的 `skills[]` 里；
   * 别的内核可能没有这个面 → 返回空数组，壳就不挂监视器）。
   * 此前壳里写死了 pi 的三个路径，等于壳知道 pi 的配置格式。
   */
  skillWatchPaths?(cwd: string): string[];

  /**
   * **旧会话的历史迁移面**：返回该内核自己存储里"还没进中立层"的旧会话（已是中立形状）。
   *
   * 为什么由内核交、而不是壳去读内核的文件：把旧格式读成中立会话是**内核专属知识**
   * （pi 的老 JSONL 命名、dsh 的 zstd 归档各不相同），而"写进中立层、幂等跳过已存在的"
   * 是**壳的机制**（中立层是壳的 canonical 真相源，内核不感知它）。
   * 这样切分之后，壳侧再没有"为了迁移而 import 某个内核实现"的例外——
   * 历史上这条通道是 application→kernel 依赖的**明文豁免**（session-single-source §4.3），
   * 现在豁免本身可以取消了。缺省 undefined = 该内核无历史迁移需求。
   */
  readLegacySessions?(): NeutralSession[];

  /** **旧状态的一次性迁移面**（内核自己的历史遗留：如 dsh 的 prefs 明文 apiKey → 凭证库）。
   *  只在启动时调一次，必须幂等。缺省 undefined = 无此面。 */
  migrateLegacyState?(): void;

  /** 内置 skills 挂/摘(pi 专属:settings.json skills[];enabled = 挂/摘)。缺省 undefined = 无此面。 */
  ensureSkills?(enabled: boolean): Promise<boolean>;

  /** 旧命名 skills 一次性迁移(pi 专属;返回 changed 供壳广播刷新)。缺省 undefined = 无此面。 */
  migrateSkills?(): Promise<boolean>;

  /** 壳插件生命周期钩子(pi 专属:插件携带 skills 目录/pi 扩展的挂/摘)。缺省 undefined = 无此面。
   *  onActivate/onDeactivate 返回 changed 供壳广播刷新。壳的 PluginLifecycleDeps 从 registry 遍历拿。 */
  createLifecycle?(): {
    skillsEnsure?: {
      onActivate(pluginId: string, pluginPath: string, source: string): Promise<boolean>;
      onDeactivate(pluginId: string, pluginPath: string, source: string): Promise<boolean>;
    };
  };
}
