// 圆心:PluginContext 契约 —— 插件能调用的 API 接口(圆心拥有,零外部依赖)。
//
// 依据 DESIGN.md §3.2.4(PluginContext 接口)、§3.2.5(RendererPluginContext)。
// 圆心只定义接口形状,实现在 application/shell 注入(依赖倒置)。
// 接口里只用圆心中性类型,不 import react/electron/pi(圆心纯度纪律)。
//
// 本文件当前只钉死 config 子对象(本次"插件配置"目标的核心契约);
// rpc/events/i18n/management 等子对象随各阶段补,在此先占位最小集。

import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi,
  FsApi, GitReadApi, GitWriteApi, LlmOneshotApi, DialogApi, ImageInput, BashResult, HeaderPatch, SessionInfo,
  KnownToolInfo,
} from "./sessions";
import type { ModelInfo } from "./events/session-state";

/** dsh 模型单条(dsh 侧模型字段:id/name/contextWindow/maxTokens,无 pi 的 reasoning)。 */
export interface DshModelSpec {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** dsh 一个 provider 路由 + 连接事实(api/baseURL)+ 模型列表(等价 pi 的 provider 详情)。
 *  密钥不落此结构:桌面端全局「API Key」输入 → spawn 注入 DEEPSEEK_API_KEY env。 */
export interface DshProvider {
  provider: string;
  api?: string;
  baseURL?: string;
  models: DshModelSpec[];
}
import type { BusApi } from "./events/session-bus";
import type { PluginListItem, FontPresetContribution } from "./contributions";
import type { ExtensionInfo } from "./extensions";
import type { SkillInfo } from "./skills";
import type { LayoutApi } from "./layout";

/** 插件配置 API(统一项目级配置通道,docs/design/unified-project-config.md)。
 *  默认读写项目级 <cwd>/.my-harness-desktop/config/{pluginId}.json,全局层自动兜底;
 *  renderer 侧经 window.pi.config(IPC)实现,IPC 本质异步,故 get/all 亦为异步。
 *  调用方用 await 或 .then 拿值,不存在返回 undefined,用 ?? 兜底默认值。 */
export interface PluginConfigApi {
  /** 异步读一个配置 key(经 IPC,两层合并后);不存在返回 undefined,调用方用 ?? 兜底默认值。 */
  get<T>(key: string): Promise<T | undefined>;
  /** 异步写一个配置 key。默认写项目级(无项目时落全局);scope:"global" 显式写全局层。
   *  value 传 undefined 时从目标层移除该 key(回落另一层/消失);落盘完成 resolve。 */
  set<T>(key: string, value: T, opts?: { scope?: "project" | "global" }): Promise<void>;
  /** 异步读整个合并后的配置快照(项目级覆盖全局层,顶层 key 浅合并)。 */
  all(): Promise<Record<string, unknown>>;
  /** 异步读某一层的原始快照(不合并——并集型数据需要区分层时用,覆盖型配置用 all 即可)。 */
  getScope(scope: "project" | "global"): Promise<Record<string, unknown>>;
}

/** i18n 翻译能力(05-plugin-i18n §9)。t 同步查字典;locale 是当前语言(zh-CN/zh-TW/en/de)。 */
export interface I18nApi {
  t(key: string, vars?: Record<string, unknown>): string;
  locale: string;
  list?(): Promise<{ id: string; name: string }[]>;
}

/**
 * 插件上下文(圆心拥有,shell 注入实现)。
 *
 * 接口按关注点分组,每组继承 RpcOps 基类(共享 getStats):
 * - sessions:会话生命周期(不继承 RpcOps——管进程和文件,不是发命令)
 * - messaging:消息发送(prompt/abort/steer/followUp/abortRetry)
 * - models:模型与推理(getModels/setModel/cycleModel/thinkingLevel)
 * - tree:会话树操作(fork/clone/getForkMessages)
 * - maintenance:会话维护(compact/exportHtml/autoCompaction/autoRetry)
 * - queue:队列模式(setSteeringMode/setFollowUpMode)
 * - bash?:Bash 执行(需声明 rpc:bash 权限)
 *
 * 新底座命令加进来时,新建子接口 extends RpcOps,加到 PluginContext,已有接口不改(开闭原则)。
 */
export interface PluginEventsApi {
  emit(channel: string, payload?: unknown): void;
  on(channel: string, handler: (payload: unknown) => void, opts?: { replayLast?: boolean }): () => void;
  /** 定向分派到别的插件的 channel(框架约定的调用通道用;普通 pub/sub 仍走 emit/on)。
   *  目标无订阅者时入队,首个订阅者 attach 时冲刷(恰好一次投递)。 */
  invoke(channel: string, payload?: unknown): void;
}

/** 应用基本信息(经 IPC 从 main 进程获取,renderer 无法自行访问 app.getVersion 等)。 */
export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  isPackaged: boolean;
}

/** pi 底座状态视图(kernel.status / setCustomCliDir 共享,供设置页展示;
 *  docs/design/custom-cli-path.md §2.6)。"装了什么"与"在跑什么"分列承载。 */
export interface KernelStatusView {
  /** 生效底座的版本(自定义生效时=自定义版本;读不到为 null) */
  currentVersion: string | null;
  /** 数据根安装版本 */
  installedVersion: string | null;
  /** 生效底座是否可用(自定义失效时跟随数据根状态) */
  available: boolean;
  /** 生效来源(custom=自定义目录;installed=数据根)。语义字段,消费者(UI)读它展示,非引擎分支戳 */
  source: "custom" | "installed";
  /** 当前配置的自定义底座目录("" = 未设置) */
  customCliDir: string;
  /** 不可用时的错误信息(含"自定义失效已回落"标注) */
  error: string | null;
}

export interface PluginContext {
  config: PluginConfigApi;
  sessions: SessionsApi;
  messaging: MessagingApi;
  models: ModelApi;
  tree: SessionTreeApi;
  maintenance: SessionMaintenanceApi;
  queue: QueueModeApi;
  i18n: I18nApi;
  fs?: FsApi;
  git?: GitReadApi;
  gitWrite?: GitWriteApi;
  llm?: LlmOneshotApi;
  bash?: BashApi;
  bus?: BusApi;
  dialog: DialogApi;
  events: PluginEventsApi;
  prefs: { get: <T>(key: string) => Promise<T>; set: (key: string, value: unknown) => Promise<void> };
  themes: { list: () => Promise<{ id: string; name: string }[]>; build: (themeId: string, fontScale: number, fontMono: string, fontEnglish: string, fontChinese: string) => Promise<Record<string, string>> };
  /** 字体预设(fontPresets 槽):字体选项清单,theme-manager 等消费方查槽渲染。
   *  插件不感知 IPC/注册表——只看到返回的数据(id/category/labelKey/stack/generic)。 */
  fonts: { list: () => Promise<FontPresetContribution[]> };
  kernel: { status: () => Promise<KernelStatusView>; setCustomCliDir: (dir: string) => Promise<{ ok: boolean; error: string | null; pendingCount: number; status: KernelStatusView | null }>; listVersions: (forceRefresh?: boolean) => Promise<{ versions: string[]; latest: string | null }>; install: (version: string, onProgress: (line: string) => void, onDone: (r: { ok: boolean; error: string | null }) => void) => Promise<{ ok: boolean; error: string | null }>; toolgateAvailable: () => Promise<boolean>; knownTools: (cwd: string) => Promise<KnownToolInfo[] | null> };
  /** dsh 内核版本管理(与 pi 同构,@deepseek-ai/dsh)。无 toolgate/knownTools(dsh 缺面)。 */
  dshKernel: { status: () => Promise<KernelStatusView>; setCustomCliDir: (dir: string) => Promise<{ ok: boolean; error: string | null; status: KernelStatusView | null }>; listVersions: (forceRefresh?: boolean) => Promise<{ versions: string[]; latest: string | null }>; install: (version: string, onProgress: (line: string) => void, onDone: (r: { ok: boolean; error: string | null }) => void) => Promise<{ ok: boolean; error: string | null }> };
  /** dsh 模型配置(读写 settings.yaml 的多 provider 路由 models + 默认模型)。 */
  dshModels: {
    get: () => Promise<DshProvider[]>;
    set: (provider: string, detail: { api?: string; baseURL?: string; models: DshModelSpec[] }) => Promise<DshProvider[]>;
    removeProvider: (provider: string) => Promise<DshProvider[]>;
    renameProvider: (oldId: string, newId: string) => Promise<DshProvider[]>;
    getDefault: () => Promise<{ provider: string; model: string; reasoningEffort?: string } | null>;
    setDefault: (sel: { provider: string; model: string; reasoningEffort?: string }) => Promise<{ provider: string; model: string; reasoningEffort?: string } | null>;
    test: (cwd: string, provider: string, modelId: string) => Promise<{ ok: boolean; error?: string }>;
  };
  /** dsh 配置(整份 ~/.dsh/settings.yaml 读写)。 */
  dshSettings: { get: () => Promise<Record<string, unknown>>; set: (obj: Record<string, unknown>) => Promise<Record<string, unknown>> };
  /** dsh 拓展(Cordis 插件树:列可用/已启用/已禁用、禁/启/装)。 */
  dshPlugins: {
    list: () => Promise<{ id: string; name: string }[]>;
    listAvailable: () => Promise<{ name: string }[]>;
    listDisabled: () => Promise<{ id: string; name: string }[]>;
    disable: (id: string) => Promise<{ id: string; name: string }[]>;
    enable: (id: string) => Promise<{ id: string; name: string }[]>;
    install: (pkgName: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error?: string; id?: string }>;
  };
  modelsConfig: { get: <T>() => Promise<T>; set: <T>(config: T) => Promise<T>; list: () => Promise<ModelInfo[]> };
  piSettings: { get: () => Promise<Record<string, unknown>>; set: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>; schema: () => Promise<{ key: string; type: string }[]> };
  /** 只读旧数据迁移窄口(读白名单内 JSON):一次性搬迁专用——常规配置读写走 ctx.config,新代码勿用。
   *  append 是 JSONL 追加原语的透传(docs/design/session-jsonl-append.md §5.3,通用 JSONL 追加是
   *  桌面插件的合理能力):服务 session 文件等 append-only 文件;entry 开放形状,原语中性。 */
  configFile: {
    get: (path: string) => Promise<Record<string, unknown>>;
    append: (path: string, entry: Record<string, unknown>) => Promise<void>;
    /** 读白名单内文件为 base64(不存在返回 null)。 */
    readBinary: (path: string) => Promise<string | null>;
    /** 写二进制文件(base64 解码后落盘;白名单内)。 */
    writeBinary: (path: string, base64: string) => Promise<void>;
  };
  plugins: { list: () => Promise<PluginListItem[]>; enable: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>; disable: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>; uninstall: (pluginId: string) => Promise<{ ok: boolean; error: string | null; errorArgs?: string[] }>; reload: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>; reportLoadFailed: (pluginId: string) => Promise<void>; install: (source: { type: "url" | "local"; location: string }) => Promise<{ ok: boolean; error: string | null }>; onUnloaded: (cb: (pluginId: string, components: string[]) => void) => () => void; onPluginsChanged: (cb: (nonce: number) => void) => () => void };
  extension: { list: () => Promise<ExtensionInfo[]>; enable: (source: string) => Promise<void>; disable: (source: string) => Promise<void>; reorder: (sources: string[]) => Promise<void>; install: (source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error: string | null }>; update: (source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error: string | null }>; remove: (source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error: string | null }> };
  skills: { list: (cwd: string) => Promise<SkillInfo[]>; toggle: (opts: { filePath: string; sourcePath: string; enabled: boolean; scope: "user" | "project"; cwd: string }) => Promise<void>; toggleForce: (opts: { filePath: string; force: boolean }) => Promise<void>; addPath: (opts: { path: string; scope: "user" | "project"; cwd: string }) => Promise<void>; removePath: (opts: { path: string; scope: "user" | "project"; cwd: string }) => Promise<void>; getSourcePaths: (cwd: string) => Promise<{ user: string[]; project: string[] }>; getBundled: () => Promise<{ path: string; enabled: boolean }>; setBundledEnabled: (enabled: boolean) => Promise<void>; watch: (cwd: string, onChanged: () => void) => () => void };
  restart: { pendingSessions: () => Promise<{ sessionKey: string; state: unknown }[]>; restart: (sessionKey: string) => Promise<void>; restartAllIdle: () => Promise<void>; onStateChange: (cb: (sessionKey: string, state: unknown) => void) => () => void };
  openFile: (path: string) => Promise<void>;
  appInfo: { get: () => Promise<AppInfo>; restart: () => Promise<void> };
  /** 动态布局引擎 API(§3.1):插件经 ctx.layout.openView(req) 打开视图,pluginId 由 ctx 实现自动注入。 */
  layout: LayoutApi;
}

/**
 * RendererPluginContext 不含 config(DESIGN.md:795-830)——
 * renderer 拿只读配置快照,改了经 onSave→worker 落盘。
 * 当前内置插件全是 renderer 形态、经 window.pi 桥访问能力,故 renderer 侧
 * 复用本接口(@my-harness-desktop/react 的 usePluginContext 按 pluginId 绑定);
 * permissions 的"未声明不注入"在 main IPC 边界强制(抛错),worker 化后改为真不注入。
 */
