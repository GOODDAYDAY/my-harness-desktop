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
  FsReadApi, GitReadApi, DialogApi, ImageInput, BashResult, HeaderPatch, SessionInfo,
} from "./sessions";
import type { PluginListItem } from "./contributions";
import type { ExtensionInfo } from "./extensions";
import type { SkillInfo } from "./skills";

/** 插件配置 API。renderer 侧经 window.pi.config(IPC)实现,IPC 本质异步,故 get/all 亦为异步。
 *  调用方用 await 或 .then 拿值,不存在返回 undefined,用 ?? 兜底默认值。 */
export interface PluginConfigApi {
  /** 异步读一个配置 key(经 IPC);不存在返回 undefined,调用方用 ?? 兜底默认值。 */
  get<T>(key: string): Promise<T | undefined>;
  /** 异步写一个配置 key;落盘完成 resolve。 */
  set<T>(key: string, value: T): Promise<void>;
  /** 异步读整个合并后的配置快照(项目级覆盖用户级)。 */
  all(): Promise<Record<string, unknown>>;
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
  fs?: FsReadApi;
  git?: GitReadApi;
  bash?: BashApi;
  dialog: DialogApi;
  events: PluginEventsApi;
  prefs: { get: <T>(key: string) => Promise<T>; set: (key: string, value: unknown) => Promise<void> };
  themes: { list: () => Promise<{ id: string; name: string }[]>; build: (themeId: string, fontScale: number, fontMono: string, fontSans: string) => Promise<Record<string, string>> };
  kernel: { status: () => Promise<{ currentVersion: string | null; available: boolean; error: string | null }>; listVersions: (forceRefresh?: boolean) => Promise<{ versions: string[]; latest: string | null }>; install: (version: string, onProgress: (line: string) => void, onDone: (r: { ok: boolean; error: string | null }) => void) => Promise<{ ok: boolean; error: string | null }> };
  modelsConfig: { get: <T>() => Promise<T>; set: <T>(config: T) => Promise<T> };
  piSettings: { get: () => Promise<Record<string, unknown>>; set: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>; schema: () => Promise<{ key: string; type: string }[]> };
  configFile: { get: (path: string) => Promise<Record<string, unknown>>; set: (path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace") => Promise<Record<string, unknown>>; getLayered: (cwd: string, relPath: string) => Promise<Record<string, unknown> | null>; getProject: (cwd: string, relPath: string) => Promise<Record<string, unknown> | null>; setProject: (cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace") => Promise<Record<string, unknown>>; clearProject: (cwd: string, relPath: string) => Promise<void> };
  plugins: { list: () => Promise<PluginListItem[]>; enable: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>; disable: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>; uninstall: (pluginId: string) => Promise<{ ok: boolean; error: string | null; errorArgs?: string[] }>; reload: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>; reportLoadFailed: (pluginId: string) => Promise<void>; install: (source: { type: "url" | "local"; location: string }) => Promise<{ ok: boolean; error: string | null }>; onUnloaded: (cb: (pluginId: string, components: string[]) => void) => () => void; onPluginsChanged: (cb: (nonce: number) => void) => () => void };
  extension: { list: () => Promise<ExtensionInfo[]>; enable: (source: string) => Promise<void>; disable: (source: string) => Promise<void>; reorder: (sources: string[]) => Promise<void>; install: (source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error: string | null }>; update: (source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error: string | null }>; remove: (source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error: string | null }> };
  skills: { list: (cwd: string) => Promise<SkillInfo[]>; toggle: (opts: { filePath: string; sourcePath: string; enabled: boolean; scope: "user" | "project"; cwd: string }) => Promise<void>; toggleForce: (opts: { filePath: string; force: boolean }) => Promise<void>; addPath: (opts: { path: string; scope: "user" | "project"; cwd: string }) => Promise<void>; removePath: (opts: { path: string; scope: "user" | "project"; cwd: string }) => Promise<void>; getSourcePaths: (cwd: string) => Promise<{ user: string[]; project: string[] }>; watch: (cwd: string, onChanged: () => void) => () => void };
  restart: { pendingSessions: () => Promise<{ sessionKey: string; state: unknown }[]>; restart: (sessionKey: string) => Promise<void>; restartAllIdle: () => Promise<void>; onStateChange: (cb: (sessionKey: string, state: unknown) => void) => () => void };
  openFile: (path: string) => Promise<void>;
}

/**
 * RendererPluginContext 不含 config(DESIGN.md:795-830)——
 * renderer 拿只读配置快照,改了经 onSave→worker 落盘。
 * 当前内置插件全是 renderer 形态、经 window.pi 桥访问能力,故 renderer 侧
 * 复用本接口(@pi-desktop/react 的 usePluginContext 按 pluginId 绑定);
 * permissions 的"未声明不注入"在 main IPC 边界强制(抛错),worker 化后改为真不注入。
 */
