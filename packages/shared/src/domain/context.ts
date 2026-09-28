// 圆心:PluginContext 契约 —— 插件能调用的 API 接口(圆心拥有,零外部依赖)。
//
// 依据 DESIGN.md §3.2.4(PluginContext 接口)、§3.2.5(RendererPluginContext)。
// 圆心只定义接口形状,实现在 application/shell 注入(依赖倒置)。
// 接口里只用圆心中性类型,不 import react/electron/pi(圆心纯度纪律)。
//
// 本文件当前只钉死 config 子对象(本次"插件配置"目标的核心契约);
// rpc/events/i18n/management 等子对象随各阶段补,在此先占位最小集。

import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, BashApi,
  FsApi, GitReadApi, GitWriteApi, LlmOneshotApi, DialogApi, ImageInput, BashResult, HeaderPatch, SessionInfo,
  KnownToolInfo,
} from "./sessions";
import type { ModelInfo } from "./events/session-state";

// ⚠ 此处曾声明 `DshModelSpec` / `DshProvider` / `DshDefaultModel` / `DshConfigApi` 四个
// **dsh 专属**类型——已下移到 `src/server/kernel/dsh/backend/dsh-config-contract.ts`。
// 理由：它们的真实消费者全部在 `kernel/dsh/` 内部，壳侧三处 import 经核实全是死 import；
// 而 `addPluginBlock`（cordis 插件块）、`~/.dsh/.credentials.yaml` 的密钥语义、
// `reasoningEfforts` 档位映射都是 dsh 的私有知识，按 §4.2「圆心 = 拿掉所有会变的东西之后
// 还剩什么」，换掉 dsh 它们就该消失。壳驱动内核配置走中性 `KernelConfigApi`
// （`get`/`set`/`fields()`，三个内核各自实现），dsh 的 provider CRUD 由 dsh 自己的
// 内核插件（`src/plugins/kernels/dsh/renderer/models.tsx`）经该中性面消费。

// ⚠ 此处曾声明 `SchemaField` 与 `PiSettingsApi`——已下移到
// `src/server/kernel/pi/manager/pi-settings-contract.ts`。理由：两者的真实消费者全在
// `kernel/pi/` 内部（pi 的 settings store 解析 .d.ts 产出 SchemaField，pi-kernel-config
// 再把它翻成**中性** `KernelConfigField` 包进中性 `KernelConfigApi`），壳侧唯一的 import
// 是死 import。`SchemaField` 是 pi 的内部表示（"解析内核 .d.ts 得到的字段"——dsh 不解析 .d.ts），
// `KernelConfigField` 才是中性契约；把内部表示放圆心 = 让圆心认识"某个内核怎么解析自己的配置"。

/** pi 内核 models.json 的中性读写面(整份读/写;pi 专属存储,壳经此面访问)。 */
export interface ModelsConfigApi {
  get(): unknown;
  set(config: unknown): Promise<void>;
}

/** 内核模型配置注册表(pi/dsh 各交一个 KernelModelsApi;bootstrap 组装,api/ipc 经此中性面访问)。 */
export type KernelModelsRegistry = Record<KernelId, KernelModelsApi>;

// ===== 中性内核管理设置契约(kernel-design-spec.md §12.4/§12.5/§12.6)=====
// 设置页三 TAB(内核版本/模型/拓展)的统一功能面:内核只交基础功能(列表/安装/卸载/
// 模型 CRUD 数据/插件数据),展示走 packages/react 的共享 base。差异经适配器翻译
// (形状)+ capabilities(能力旗标降级)抹平,UI 不据内核身份分支(§7.5 渲染纯函数)。

/** 中性模型单条(统一形状:不暴露 baseURL / apiKeyEnv 这类内核拼写)。 */
export interface NeutralModel {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** 端点是否支持 OpenAI `developer` 角色(系统提示的角色拼写)。部分 OpenAI 兼容网关
   *  (如 bifrost 的 tencent 路由)只认 `system`,pi-ai 对 reasoning 模型默认发 `developer`
   *  会被 400 拒——置 false 让 pi-ai 退回 `system`。映射到 pi models.json 的
   *  `compat.supportsDeveloperRole`。 */
  supportsDeveloperRole?: boolean;
}

/** 中性 provider(统一形状)。apiKey 是「API Key 字面值」:pi 内联写 models.json,
 *  dsh 写 dsh 凭证库(~/.dsh/.credentials.yaml refs)、settings.yaml 的 route 只写派生的
 *  apiKeyEnv 引用,spawn 不注入进程 env。 */
export interface NeutralProvider {
  id: string;
  displayName?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models: NeutralModel[];
}

/** 中性默认模型选择。 */
export interface NeutralDefaultModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** 中性模型配置快照(providers + default):框架 settings 的「内核模型 config source」读/存单位。
 *  壳子只认这份中性 JSON,pi/dsh 各自把它翻译成自己的 models.json / settings.yaml。 */
export interface KernelModelConfig {
  providers: NeutralProvider[];
  default: NeutralDefaultModel | null;
}

/** 模型配置的中性 API(pi/dsh 各交一个适配器,组装归 bootstrap)。 */
export interface KernelModelsApi {
  list(): Promise<NeutralProvider[]>;
  set(provider: string, detail: Omit<NeutralProvider, "id">): Promise<NeutralProvider[]>;
  remove(provider: string): Promise<NeutralProvider[]>;
  rename(oldId: string, newId: string): Promise<NeutralProvider[]>;
  getDefault(): Promise<NeutralDefaultModel | null>;
  setDefault(sel: NeutralDefaultModel): Promise<NeutralDefaultModel | null>;
  test(cwd: string, provider: string, modelId: string): Promise<{ ok: boolean; error?: string }>;
  /** 读整份中性模型配置(providers + default)。 */
  readConfig(): Promise<KernelModelConfig>;
  /** 存整份中性模型配置(全量 reconcile:删缺、增改、设默认),返回落盘后的配置。 */
  saveConfig(config: KernelModelConfig): Promise<KernelModelConfig>;
}

/** 模型配置能力旗标(数据,UI 据以显式降级,不据内核身份分支)。 */
export interface KernelModelsCapabilities {
  reasoning: boolean;
  /** 该内核的模型配置里**是否有「developer 角色兼容性」这一维**。
   *
   *  为什么需要这一轴（r44）：共享的 `ModelConfigPage` 里有一个「developer role 不兼容」勾选框，
   *  它写的是 `supportsDeveloperRole`——而这个字段**只有 pi 消费**
   *  （`src/server/kernel/pi/model/models-config.ts` 的 `compat.supportsDeveloperRole`，
   *  作用是让 reasoning 模型用 system 而非 developer 角色）。dsh 与 minimal 都没有消费者，
   *  但控件此前**无条件渲染**，于是它们的模型配置页上出现一个勾了也没任何作用的开关
   *  ——§7.6 说的"该显式降级却没降级"，也是典型的功能漂移（控件在，语义不在）。
   *
   *  ⚠ 设为**必填**而不是可选：可选会让"忘了声明"静默等同于 false（或 undefined 被判假），
   *  必填则让新内核接入时**必须当场表态**（编译期 TS2739），与 r38 给分页部件的
   *  `prevLabel`/`nextLabel` 设为必填是同一个手法。 */
  developerRole: boolean;
}

// ===== 内核原生配置的中性契约(kernel 配置 TAB 用)=====
// 字段名 + 类型从内核来(pi 解析 .d.ts),label/description/group 是**壳的本地化 i18n key**,
// 由共享表单 t() 解析。壳不硬编码字段清单、不写死文案——只消费内核 schema + 贡献本地化文案。

/** 中性配置字段描述。key 是扁平点路径(pi: compaction.enabled;dsh: permission.defaultPreset)。
 *  type 是**通用数据型**(非 UI 控件型),label/description/group 是 i18n key。 */
export interface KernelConfigField {
  key: string;
  /** 通用数据型:boolean/number/string/string[]/enum/object。控件由壳自己映射(enum→下拉、object→JSON)。 */
  type: "boolean" | "number" | "string" | "string[]" | "enum" | "object";
  /** 展示名 i18n key(缺省 = key)。 */
  label?: string;
  /** 说明文案 i18n key。 */
  description?: string;
  /** enum 型的选项(value 是内核枚举字面值,label 是 i18n key,缺省 = value)。
   *
   *  `kind` 是**写回时的值种类**，缺省 `"string"`（向后兼容：既有内核不声明即全字符串）。
   *  为什么需要它：内核的配置字段可能是**混合字面量联合**，例如 `boolean | "auto"`、
   *  `"kitty" | "iterm2" | "auto" | false`。下拉框的选项值只能是字符串（HTML `<option value>`
   *  的约束），但写回配置文件时 `true`/`false`/`1` 必须是**真布尔/真数字**，否则内核读到
   *  字符串 `"true"` 会当成真值处理甚至类型不符。没有 `kind` 时这类字段只能整体降级成
   *  `object`（裸 JSON 编辑器，用户得手敲 `true` / `"auto"`）——实测 pi 有 3 个字段因此降级
   *  （`terminal.hyperlinks` / `terminal.images` / `terminal.trueColor`），而同一个表单对
   *  **纯字符串**联合却给的是下拉框：同一张表单里能力不一致，那是缺陷不是取舍。 */
  options?: { value: string; label?: string; kind?: "string" | "boolean" | "number" }[];
  /** 分组 i18n key(表单按组渲染,缺省进「其他」)。 */
  group?: string;
}

/** 中性内核原生配置 API(pi/dsh 各交一个适配器,组装归 bootstrap)。读 = 全量 JSON 出,写 = 全量 JSON 入。 */
export interface KernelConfigApi {
  get(): Promise<Record<string, unknown>>;
  set(obj: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 字段清单(字段名+通用类型从内核来,label/description/group 是壳 i18n key)。 */
  fields(): Promise<KernelConfigField[]>;
}

import type { BusApi } from "./events/session-bus";
import type { ModelProbeApi } from "./model-probe";
import type { PluginListItem, FontPresetContribution } from "./contributions";
import type { KernelExtensionInfo , KernelExtensionCapabilities } from "./extensions";
import type { KernelId } from "./kernel";
import type { SkillInfo, SkillCapabilities } from "./skills";
import type { LayoutApi } from "./layout";

/** 插件配置 API(统一项目级配置通道,docs/design/unified-project-config.md)。
 *  默认读写项目级 <cwd>/.my-harness-desktop/config/{pluginId}.json,全局层自动兜底;
 *  renderer 侧经 window.kernel.config(IPC)实现,IPC 本质异步,故 get/all 亦为异步。
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
 * 新内核命令加进来时,新建子接口 extends RpcOps,加到 PluginContext,已有接口不改(开闭原则)。
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
  /** Electron 版本;服务器宿主无 Electron → null(web-service §5.2)。 */
  electron: string | null;
  node: string;
  /** Chrome 版本;服务器宿主无 Electron → null(§5.2)。 */
  chrome: string | null;
  platform: string;
  isPackaged: boolean;
}

/** pi 内核状态视图(kernel.status / setCustomCliDir 共享,供设置页展示;
 *  docs/design/custom-cli-path.md §2.6)。"装了什么"与"在跑什么"分列承载。 */
export interface KernelStatusView {
  /** 生效内核的版本(自定义生效时=自定义版本;读不到为 null) */
  currentVersion: string | null;
  /** 数据根安装版本 */
  installedVersion: string | null;
  /** 生效内核是否可用(自定义失效时跟随数据根状态) */
  available: boolean;
  /** 生效来源(custom=自定义目录;installed=数据根)。语义字段,消费者(UI)读它展示,非引擎分支戳 */
  source: "custom" | "installed";
  /** 当前配置的自定义内核目录("" = 未设置) */
  customCliDir: string;
  /** 不可用时的错误信息(含"自定义失效已回落"标注) */
  error: string | null;
}

/** 内核版本管理的中性功能面(pi/dsh 同构;settings 三 TAB 的「内核版本」TAB 消费)。
 *  pi/dsh 各交一个实例,壳经 kernels[KernelId] 访问——不再有 kernel/dshKernel 两个面。 */
export interface KernelVersionApi {
  /**
   * 这个内核的版本面**支持什么**（数据，UI 据以显式降级；不按内核身份分支）。
   *
   * 为什么需要它：随壳分发的内置内核（minimal）**没有**安装/切换版本这回事，
   * 也没有"自定义内核目录"。缺了旗标，设置页只能把两个用不了的控件照样画出来让人点，
   * 或者让每个内核的对接面各写一份条件渲染（= 按内核分支，§1.4 禁止）。
   * 有旗标之后是**同一份 UI + 数据驱动的隐藏**：加第四个内核只填它自己的旗标。
   */
  capabilities(): Promise<{
    /** 支持安装/切换版本（内置内核为 false）。 */
    install: boolean;
    /** 支持指定自定义内核目录（内置内核为 false）。 */
    customDir: boolean;
  }>;
  status(): Promise<KernelStatusView>;
  setCustomCliDir(dir: string): Promise<{ ok: boolean; error: string | null; pendingCount: number; status: KernelStatusView | null }>;
  listVersions(forceRefresh?: boolean): Promise<{ versions: string[]; latest: string | null }>;
  install(version: string, onProgress: (line: string) => void, onDone: (r: { ok: boolean; error: string | null }) => void): Promise<{ ok: boolean; error: string | null }>;
  /** **该内核能否强制执行工具白名单**（壳下发的 `SessionToolConfig.enabledToolIds`）。
   *
   *  每个内核按**自己的机制**回答同一个中性问题：
   *  - 靠装桌面适配扩展来硬过滤的内核：答"那个扩展装好了没"；
   *  - 工具系统是内核本体的内核：答 true（它自己把 `enabledToolIds` 翻译成自己的工具集/开关
   *    语义，见 `docs/design/minimal-kernel.md` §5.6.1，并自带档位门控 §5.7.1）；
   *  - 没有工具配置面的内核：不声明（缺面）→ 调用方显式降级，不静默、不伪造。
   *
   *  壳用它决定两件事：① 发送前要不要把工具限制**软注入**进 prompt（不能硬过滤时的散文补偿）；
   *  ② 工具管理页要不要显示"当前内核无工具过滤能力"的降级警告。
   *
   *  ⚠ 本方法曾叫 `fitPiExtensionAvailable`、后改 `fitExtensionAvailable`——两版都**问错了问题**：
   *  "桌面适配扩展装没装"只是**某一个内核**实现强制过滤的手段，不是"能不能强制过滤"本身。
   *  用前者代理后者的后果是实测到的：一个自带工具门控的内核被判为"不能过滤"，于是每次发送
   *  都被拼上一段冗余的散文限制说明（echo 内核会把它原样回显到时间线，弄坏 DOM 对账）。
   *  更早的版本还固定问某一个内核，于是答案取决于**别的内核**装没装扩展——环境依赖。 */
  toolFilterEnforced?(): Promise<boolean>;
}

export interface PluginContext {
  config: PluginConfigApi;
  sessions: SessionsApi;
  messaging: MessagingApi;
  models: ModelApi;
  tree: SessionTreeApi;
  // ⚠ 此处曾有 `pi: PiExtensions`（内核名命名的能力袋子）——**已退役**：12 个方法按语义域
  // 归位到 `messaging`（steer/followUp/两个 mode/abortRetry/setAutoRetry）、`models`
  // （cycleModel/getThinkingLevels/cycleThinkingLevel）、`sessions`（compact/setAutoCompaction/
  // getLastAssistantText）。可用性判据改为**逐轴**能力面 `capabilities.faces.<轴>`，
  // 不再是「有没有那个袋子」的一个 bit。同时删掉了 `SessionsApi.pi` 那条重复访问路径
  // （同一个接口曾有两个入口）。
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
  /** 内核版本管理(统一对外面,按 KernelId 键控):pi/dsh 各交一个 KernelVersionApi。
   *  pi 多 fitExtensionAvailable,dsh 缺面(工具发现经 sessions.listTools 契约)。 */
  kernels: Record<KernelId, KernelVersionApi>;
  /** 中性内核管理 API(pi/dsh/minimal 各一个适配器;settings 三 TAB 共享 base 消费,kernel-design-spec §12.4/§12.5/§12.6)。 */
  kernelModels: KernelModelsRegistry;
  /** 模型探测(发现 + ping;核心默认,零权限):对 OpenAI 兼容端点的纯 HTTP 探测,
   *  内核无关,不起内核进程。设置页模型列表「从 Base URL 发现」区块消费。 */
  modelsProbe: ModelProbeApi;
  /** 中性内核原生配置 API(pi/dsh/minimal 各交一个适配器;settings 配置 TAB 用,读=JSON 出、写=JSON 入)。 */
  kernelConfig: Record<KernelId, KernelConfigApi>;
  modelsConfig: { list: () => Promise<ModelInfo[]>; getFallbackModel: () => Promise<{ provider: string; model: string; kernel: KernelId } | null> };
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
  /** 内核拓展管理(中性,按 kernel 作用域):pi/dsh 各交一个 KernelExtensionSource,壳经此访问。 */
  kernelExtensions: {
    list: (kernel: KernelId) => Promise<KernelExtensionInfo[]>;
    /** 该内核的扩展能力面（装/卸/更新/重排）。UI 据此**显式降级**，不做事后报错。 */
    capabilities: (kernel: KernelId) => Promise<KernelExtensionCapabilities>;
    enable: (kernel: KernelId, id: string) => Promise<void>;
    disable: (kernel: KernelId, id: string) => Promise<void>;
    install: (kernel: KernelId, source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error?: string }>;
    uninstall: (kernel: KernelId, id: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error?: string }>;
  };
  skills: { list: (cwd: string) => Promise<SkillInfo[]>; getCapabilities: () => Promise<SkillCapabilities>; setEnabled: (skill: SkillInfo, enabled: boolean) => Promise<void>; setModelInvocable: (skill: SkillInfo, value: boolean) => Promise<void>; getBundled: () => Promise<{ path: string; enabled: boolean }>; setBundledEnabled: (enabled: boolean) => Promise<void>; watch: (cwd: string, onChanged: () => void) => () => void };
  restart: { pendingSessions: () => Promise<{ sessionKey: string; state: unknown }[]>; restart: (sessionKey: string) => Promise<void>; restartAllIdle: () => Promise<void>; onStateChange: (cb: (sessionKey: string, state: unknown) => void) => () => void };
  openFile: (path: string) => Promise<void>;
  appInfo: { get: () => Promise<AppInfo>; restart: () => Promise<void> };
  /** 系统通知能力(核心默认,零权限):发一条 OS 通知,文案由调用方经 i18n 传。 */
  notify: { show: (opts: { title: string; body: string; silent?: boolean }) => Promise<void> };
  /** 窗口焦点查询(核心默认):notifier 判定"窗口是否前台"用。 */
  window: { isFocused: () => Promise<boolean> };
  /** 动态布局引擎 API(§3.1):插件经 ctx.layout.openView(req) 打开视图,pluginId 由 ctx 实现自动注入。 */
  layout: LayoutApi;
}

/**
 * RendererPluginContext 不含 config(DESIGN.md:795-830)——
 * renderer 拿只读配置快照,改了经 onSave→worker 落盘。
 * 当前内置插件全是 renderer 形态、经 window.kernel 桥访问能力,故 renderer 侧
 * 复用本接口(@my-harness-desktop/react 的 usePluginContext 按 pluginId 绑定);
 * permissions 的"未声明不注入"在 main IPC 边界强制(抛错),worker 化后改为真不注入。
 */
