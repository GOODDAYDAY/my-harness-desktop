import type { ComponentType } from "react";
import type { Theme, PluginListItem, KernelExtensionInfo, KernelExtensionCapabilities, SkillInfo, ManagedSkill, SkillCapabilities, SettingsItem, SettingsGroupContribution, SessionInfo, SessionEvent, SyncSnapshot, KernelEvent, QuestionRequestEvent, Question, QuestionAnswer, HeaderPatch, SessionToolConfig, SessionModelPrefs, KnownToolInfo, SessionRawFilePaths, PendingQuestionRecord, SessionHeaderChangedEvent, NeutralMessage, FileTreeNode, ReadDirTreeOptions, ProjectStats, SessionBusMessage, ConnectionInfo, GitStatusResult, GitLogEntry, KernelStatusView, KernelVersionApi, LineageTree, BookmarkSnapshot, ModelInfo, KernelId, KernelLogo, KernelModelsApi, KernelConfigApi, ModelProbeApi, ForkOptions, SessionCapabilities, ConcurrencyMode, KernelPluginReloadReport } from "@my-harness-desktop/shared";
import { asReactComponent } from "./plugin-modules";

export interface KernelApi {
  config: {
    get: <T>(pluginId: string, key: string) => Promise<T | undefined>;
    set: (pluginId: string, key: string, value: unknown, opts?: { scope?: "project" | "global" }) => Promise<void>;
    all: (pluginId: string) => Promise<Record<string, unknown>>;
    getScope: (pluginId: string, scope: "project" | "global") => Promise<Record<string, unknown>>;
  };
  prefs: {
    get: <T>(key: string) => Promise<T>;
    set: (key: string, value: unknown) => Promise<void>;
    /** 偏好变更推送(第 22 项):任一客户端 set 后广播,其他端同步主题/语言等。 */
    onChanged?: (cb: (change: { key: string; value: unknown }) => void) => () => void;
  };
  themes: {
    list: () => Promise<{ id: string; name: string }[]>;
    build: (themeId: string, fontScale: number, fontMono: string, fontEnglish: string, fontChinese: string) => Promise<Theme>;
    onSystemChanged: (cb: () => void) => () => void;
  };
  /** 字体预设(fontPresets 槽)贡献项列表。 */
  fonts: {
    list: () => Promise<{ id: string; category: "mono" | "english" | "chinese"; labelKey: string; stack: string; generic?: "serif" | "sans-serif" }[]>;
  };
  settings: {
    list: () => Promise<SettingsItem[]>;
  };
  slots: {
    sidePanel: () => Promise<{ id: string; label: string; icon: string; component: string; pluginId: string }[]>;
    sidebar: () => Promise<{ id: string; component: string; pluginId: string }[]>;
    mainView: () => Promise<{ id: string; component: string; pluginId: string }[]>;
    titlebar: () => Promise<{ id: string; component: string; pluginId: string }[]>;
    fileActions: () => Promise<{ id: string; labelKey: string; icon?: string; when?: { target?: "file" | "dir" | "both" }; pluginId: string }[]>;
    fileIcons: () => Promise<{ id: string; icon: string; extensions?: string[]; filenames?: string[]; color?: string; pluginId: string }[]>;
    messageActions: () => Promise<{ id: string; component: string; placement?: "left" | "right"; when?: { role?: string[] }; order?: number; pluginId: string }[]>;
    blockRenderers: () => Promise<{ id: string; block: string; names?: string[]; component: string; order?: number; pluginId: string }[]>;
    sessionGroupings: () => Promise<{ id: string; parentPathField: string; childLabelKey?: string; childIcon?: string; order?: number; pluginId: string }[]>;
    composerPolicies: () => Promise<{ id: string; customField: string; readonlyMessageKey?: string; order?: number; pluginId: string }[]>;
    composerAttachments: () => Promise<{ id: string; component: string; order?: number; pluginId: string }[]>;
    composerActions: () => Promise<{ id: string; component: string; order?: number; pluginId: string }[]>;
    composerStats: () => Promise<{ id: string; component: string; order?: number; pluginId: string }[]>;
    composerTop: () => Promise<{ id: string; component: string; order?: number; pluginId: string }[]>;
    composerVoice: () => Promise<{ id: string; component: string; order?: number; pluginId: string }[]>;
    codeBlockRenderers: () => Promise<{ id: string; languages: string[]; component: string; order?: number; pluginId: string }[]>;
    settingsGroups: () => Promise<(SettingsGroupContribution & { pluginId: string })[]>;
  };
  /** 已注册内核 id 清单(运行时注册表顺序)。**是活的**：内核插件重载 / 装卸内核之后
   *  壳会自动重拉（收到 `refresh.requested` 时），读它总能拿到当前清单。
   *  ⚠ 但**解构出去就死了**：`const { kernelIds } = ctx.kernel` 拿到的是解构那一刻的数组
   *  （JS 语义如此，getter 也救不了）。要新鲜就直接读 `ctx.kernel.kernelIds`。
   *  同理，`kernels` / `kernelModels` / `kernelConfig` 三张映射是**引用恒定、内容原地重建**——
   *  解构出引用仍然有效，重载后读到的是新内容。 */
  kernelIds: KernelId[];
  /** 显式重拉内核清单并重建三张 per-id 映射（幂等）。
   *  壳在收到刷新信号时会自动调它；这个入口是给"我知道内核刚变了、不想等广播"的调用方用的
   *  （例如自己触发了某个内核装卸动作之后）。 */
  reloadKernelIds: () => Promise<KernelId[]>;
  /** **差量重载内核插件**（装/删/改内核插件目录后，不重启应用即生效）。
   *  返回**两侧**的变化清单（`kernels` = 内核注册表侧、`shell` = 壳插件侧）；
   *  任一侧 `errors` 非空表示某个插件装载失败但**其余照常可用**
   *  （暖路径不把在跑的应用打回不可用状态）。
   *  与 `plugins.reload` 分工：那条重载**壳插件**生命周期，这条重载**内核注册表**。 */
  reloadKernels: () => Promise<KernelPluginReloadReport>;
  /** 内核版本管理(统一对外面,按 KernelId 键控):pi/dsh 各一个 KernelVersionApi。 */
  kernels: Record<KernelId, KernelVersionApi>;
  /** 内核身份标(logo)取回:每个内核在自己适配器声明,壳经此取回渲染(不硬编码)。 */
  kernelLogos: { get: (kernel: KernelId) => Promise<KernelLogo> };
  /** 中性内核管理 API：模型页(kernel-design-spec.md §12.5)。 */
  kernelModels: Record<KernelId, KernelModelsApi>;
  /** 模型探测(发现 + ping;domain ModelProbeApi):纯 HTTP,内核无关。 */
  modelsProbe: ModelProbeApi;
  /** 中性内核原生配置 API(kernel 配置 TAB 用):pi/dsh/minimal 各一个适配器。 */
  kernelConfig: Record<KernelId, KernelConfigApi>;
  models: {
    list: () => Promise<ModelInfo[]>;
    getFallbackModel: () => Promise<{ provider: string; model: string; kernel: KernelId } | null>;
  };
  i18n: {
    resources: () => Promise<{
      resources: Record<string, Record<string, Record<string, string>>>;
      ns: string[];
      supportedLngs: string[];
    }>;
    list: () => Promise<{ id: string; name: string }[]>;
    detect: (navigatorLanguage: string) => Promise<string>;
  };
  openFile: (path: string) => Promise<void>;
  revealPath: (path: string) => Promise<void>;
  configFile: {
    get: (path: string) => Promise<Record<string, unknown>>;
    set: (path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace") => Promise<Record<string, unknown>>;
    getLayered: (cwd: string, relPath: string) => Promise<Record<string, unknown> | null>;
    getProject: (cwd: string, relPath: string) => Promise<Record<string, unknown> | null>;
    setProject: (cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace") => Promise<Record<string, unknown>>;
    clearProject: (cwd: string, relPath: string) => Promise<void>;
    append: (path: string, entry: Record<string, unknown>) => Promise<void>;
    /** 读白名单内文件为 base64(不存在返回 null)。 */
    readBinary: (path: string) => Promise<string | null>;
    /** 写二进制文件(base64 解码后落盘;白名单内)。 */
    writeBinary: (path: string, base64: string) => Promise<void>;
  };
  sessions: {
    start: (cwd: string, sessionPath?: string) => Promise<{ ok: boolean }>;
    stop: (sessionPath?: string | null) => Promise<{ ok: boolean }>;
    setContext: (cwd: string, sessionPath: string | null) => Promise<void>;
    getSnapshot: () => Promise<unknown>;
    sync: () => Promise<unknown>;
    openSession: (sessionPath: string) => Promise<unknown>;
    readToolConfig: (sessionPath: string) => Promise<SessionToolConfig | null>;
    renameSession: (sessionPath: string, name: string) => Promise<{ ok: boolean }>;
    updateHeader: (sessionPath: string, patch: HeaderPatch) => Promise<{ ok: boolean }>;
    /** 中立层会话注解(docs/design/goal.md §8.3):只写中立层不进内核,渲染由 messageRenderers 槽认领。 */
    annotate: (sessionPath: string, customType: string, content: string) => Promise<void>;
    deleteSessions: (paths: string[]) => Promise<{ ok: boolean }>;
    list: (cwd: string) => Promise<SessionInfo[]>;
    /** 解析会话可打开的原始文件地址(中立层文件 + 内核原始文件;不存在返回 null 项)。 */
    rawFilePaths: (sessionId: string) => Promise<SessionRawFilePaths>;
    projectStats: (cwd: string) => Promise<ProjectStats>;
    getTree: (sessionId: string) => Promise<LineageTree>;
    bookmark: (sessionPath: string, entryId: string, id: string, label: string, preview: string) => Promise<BookmarkSnapshot>;
    resume: (snapshotId: string) => Promise<string>;
    deleteBookmark: (snapshotId: string) => Promise<void>;
    switchKernel: (target: KernelId) => Promise<void>;
    // 类型从圆心 import,不在此内联重写(此前是第四份本地副本 —— 同一个形状在
    // kernel-event.ts / web store / build-kernel.ts / 这里各写一遍,§1.3 契约单源违规)
    getCapabilities: () => Promise<SessionCapabilities>;
    onEvent: (cb: (event: SessionEvent) => void) => () => void;
    /** 列表行变更推送(归档/置顶/改名/删除/复制,第 21 项):payload 自带补丁,本地打行不重拉(copy 例外)。 */
    onHeaderChanged: (cb: (info: SessionHeaderChangedEvent) => void) => () => void;
    onKernelEvent: (cb: (event: KernelEvent) => void) => () => void;
    onQuestion: (cb: (req: QuestionRequestEvent) => void) => () => void;
    answerQuestion: (requestId: string, answers: QuestionAnswer[]) => Promise<void>;
    /** 读激活会话的挂起提问记录(ask 续问;卡片复活用,docs/design/ask-design.md §3.2)。 */
    getPendingQuestions: () => Promise<PendingQuestionRecord[]>;
    listTools: () => Promise<KnownToolInfo[] | null>;
    onSnapshot: (cb: (snapshot: SyncSnapshot) => void) => () => void;
    /** 中立层基线读 + 写穿回执订阅(session-single-source §3.2,镜像数据源)。 */
    getNeutral: (ns: string) => Promise<unknown>;
    onNeutralChange: (cb: (change: unknown) => void) => () => void;
    prompt: (text: string, images?: { data: string; mimeType: string; name?: string }[], display?: { image?: { src: string; title?: string } }, prefs?: SessionModelPrefs) => Promise<void>;
    abort: () => Promise<void>;
    getModels: () => Promise<unknown[]>;
    setModel: (provider: string, modelId: string, kernel: KernelId) => Promise<void>;
    /** 模型连通性测试(内核隔离临时会话 ping;对应 domain ModelApi.test) */
    testModel: (cwd: string, provider: string, modelId: string, kernel: KernelId) => Promise<{ ok: boolean; error?: string }>;
    setThinkingLevel: (level: string) => Promise<void>;
    fork: (parentLineageId: string, boundary?: string, position?: "before" | "at", opts?: ForkOptions) => Promise<string>;
    /** 从任意会话分叉派生新会话(unify §7.1 中性面,两内核平等):返回新 neutralSessionId。 */
    forkFromSession: (srcNs: string, entryId: string, position?: "before" | "at", opts?: ForkOptions) => Promise<string>;
    copySession: (srcPath: string, targetPath: string) => Promise<void>;
    getStats: () => Promise<unknown>;
    /** 克隆当前会话(session-single-source §4.2:壳的中性实现,内核不参与)。 */
    clone: () => Promise<void>;
    /** 取分叉点的消息(中立层前缀截取)。 */
    getForkMessages: (entryId: string) => Promise<unknown[]>;
    // ⚠ 此处曾是 `pi: { …12 个方法… }` 分组——**已平铺**。理由：这一层是**原始 IPC 面**，
    // 每个方法本就有自己的 channel（`IPC.session.steer` 等），分组不提供任何信息，
    // 只把内核名带进了发布面。语义分组发生在 `PluginContext`（messaging/models/sessions），
    // 那才是插件看到的层；这一层保持平铺中性。
    steer: (text: string, images?: { data: string; mimeType: string; name?: string }[]) => Promise<void>;
    followUp: (text: string, images?: { data: string; mimeType: string; name?: string }[]) => Promise<void>;
    abortRetry: () => Promise<void>;
    cycleModel: () => Promise<void>;
    getThinkingLevels: () => Promise<string[]>;
    cycleThinkingLevel: () => Promise<void>;
    compact: (customInstructions?: string) => Promise<void>;
    setAutoCompaction: (enabled: boolean) => Promise<void>;
    setAutoRetry: (enabled: boolean) => Promise<void>;
    getLastAssistantText: () => Promise<string>;
    setSteeringMode: (mode: ConcurrencyMode) => Promise<void>;
    setFollowUpMode: (mode: ConcurrencyMode) => Promise<void>;
    runBash: (command: string, excludeFromContext?: boolean) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    abortBash: () => Promise<void>;
  };
  bus: {
    status: (pluginId: string) => Promise<unknown>;
    send: (pluginId: string, to: string, kind: string, payload: unknown, replyTo?: string) => Promise<{ delivered: string }>;
    sessionCreate: (pluginId: string, opts: { task?: string; cwd?: string; name?: string; model?: { provider: string; modelId: string }; toolConfig?: unknown; watch?: boolean; channels?: string[] }) => Promise<unknown>;
    sessionAbort: (pluginId: string, session: string) => Promise<unknown>;
    channelMember: (pluginId: string, channel: string, action: "join" | "leave", member?: string) => Promise<unknown>;
    tapStart: (pluginId: string, opts: { session?: string; channel?: string; filter?: "done" | "lifecycle" | "stream"; deliverTo?: string }) => Promise<{ tapId: string; filter: string }>;
    tapStop: (pluginId: string, tapId?: string) => Promise<unknown>;
    onMessage: (cb: (message: SessionBusMessage) => void) => () => void;
  };
  fs: {
    listDir: (pluginId: string, cwd: string) => Promise<{ name: string; isDir: boolean }[]>;
    removePath: (pluginId: string, path: string) => Promise<void>;
    readDirTree: (pluginId: string, cwd: string, opts?: ReadDirTreeOptions) => Promise<FileTreeNode>;
    readFile: (pluginId: string, path: string) => Promise<string>;
    readFileBase64: (pluginId: string, path: string) => Promise<string>;
    createFile: (pluginId: string, path: string) => Promise<void>;
    createDir: (pluginId: string, path: string) => Promise<void>;
    renamePath: (pluginId: string, from: string, to: string) => Promise<void>;
    copyPath: (pluginId: string, from: string, to: string) => Promise<void>;
  };
  git: {
    status: (pluginId: string, cwd: string) => Promise<GitStatusResult>;
    fileDiff: (pluginId: string, cwd: string, path: string) => Promise<string>;
    fileContent: (pluginId: string, cwd: string, path: string) => Promise<string>;
    log: (pluginId: string, cwd: string, limit: number) => Promise<GitLogEntry[]>;
  };
  gitWrite: {
    commit: (pluginId: string, cwd: string, message: string, files: string[]) => Promise<{ ok: boolean; hash?: string; error?: string }>;
    push: (pluginId: string, cwd: string) => Promise<{ ok: boolean; error?: string }>;
  };
  llm: {
    oneshot: (pluginId: string, prompt: string) => Promise<string>;
  };
  dialog: {
    openDirectory: () => Promise<string | null>;
    openImages: () => Promise<{ name: string; data: string; mimeType: string }[]>;
    openFiles: (opts?: { filters?: { name: string; extensions: string[] }[] }) => Promise<{ name: string; path: string }[]>;
    openTextFile: (opts?: { filters?: { name: string; extensions: string[] }[] }) => Promise<{ name: string; content: string } | null>;
    saveTextFile: (opts: { name: string; content: string; filters?: { name: string; extensions: string[] }[]; defaultFileName?: string }) => Promise<string | null>;
    writeImages: (dir: string, images: { name: string; base64: string }[]) => Promise<number>;
    saveZip: (opts: { name: string; files: { name: string; base64: string }[]; defaultFileName?: string }) => Promise<string | null>;
    openZip: (opts?: { filters?: { name: string; extensions: string[] }[] }) => Promise<{ name: string; files: { name: string; base64: string }[] } | null>;
  };
  plugins: {
    list: () => Promise<PluginListItem[]>;
    enable: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>;
    disable: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>;
    uninstall: (pluginId: string) => Promise<{ ok: boolean; error: string | null; errorArgs?: string[] }>;
    reload: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>;
    reportLoadFailed: (pluginId: string) => Promise<void>;
    install: (source: { type: "url" | "local"; location: string }) => Promise<{ ok: boolean; error: string | null }>;
    onUnloaded: (cb: (pluginId: string, components: string[]) => void) => () => void;
    onPluginsChanged: (cb: (nonce: number) => void) => () => void;
  };
  onSettingsChanged: (cb: () => void) => () => void;
  /** 通用刷新信号(装/升/降级内核、自定义内核路径变更等操作完成):消费方(会话流)
   *  收到后重探挂载时探测的外部状态,不用重启。语义不绑具体资源。 */
  onRefreshRequested: (cb: () => void) => () => void;
  kernelExtensions: {
    /** 该内核的扩展能力面（装/卸/更新/重排）。UI 据此显式降级，不做事后报错（r46）。 */
    capabilities: (kernel: KernelId) => Promise<KernelExtensionCapabilities>;
    list: (kernel: KernelId) => Promise<KernelExtensionInfo[]>;
    enable: (kernel: KernelId, id: string) => Promise<void>;
    disable: (kernel: KernelId, id: string) => Promise<void>;
    install: (kernel: KernelId, source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error?: string }>;
    uninstall: (kernel: KernelId, id: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error?: string }>;
  };
  restart: {
    pendingSessions: () => Promise<{ sessionKey: string; state: unknown }[]>;
    restart: (sessionKey: string) => Promise<void>;
    restartAllIdle: () => Promise<void>;
    onStateChange: (cb: (sessionKey: string, state: unknown) => void) => () => void;
  };
  platform: NodeJS.Platform;
  app: {
    info: () => Promise<{
      name: string; version: string; electron: string; node: string; chrome: string;
      platform: string; isPackaged: boolean;
    }>;
    restart: () => Promise<void>;
  };
  notify: {
    show: (opts: { title: string; body: string; silent?: boolean }) => Promise<void>;
  };
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    isFocused: () => Promise<boolean>;
    onMaximizedChanged: (cb: (maximized: boolean) => void) => () => void;
  };
  skills: {
    list: (cwd: string) => Promise<ManagedSkill[]>;
    getCapabilities: () => Promise<SkillCapabilities>;
    setEnabled: (skill: SkillInfo, enabled: boolean) => Promise<void>;
    setModelInvocable: (skill: SkillInfo, value: boolean) => Promise<void>;
    getBundled: () => Promise<{ path: string; enabled: boolean }>;
    setBundledEnabled: (enabled: boolean) => Promise<void>;
    watch: (cwd: string, onChanged: () => void) => () => void;
  };
  /** 远程访问控制面(§18.6)。 */
  remote: {
    status: () => Promise<unknown>;
    start: () => Promise<unknown>;
    stop: () => Promise<unknown>;
    setPassword: (password: string) => Promise<unknown>;
    refreshPassword: () => Promise<string>;
    setLanPasswordEnabled: (enabled: boolean) => Promise<unknown>;
    qr: () => Promise<string | null>;
    onStateChanged: (cb: (state: unknown) => void) => () => void;
    /** 设备管理(第 23/24 项)。 */
    connections: () => Promise<ConnectionInfo[]>;
    kick: (id: string) => Promise<{ ok: boolean }>;
    kickAll: () => Promise<{ ok: boolean; kicked: number }>;
    onConnectionsChanged: (cb: (list: ConnectionInfo[]) => void) => () => void;
  };
}

/** 宿主原生能力面(web-service §4.3/§16.2):依赖运行时环境(Electron/Node),远程降级。
 *  这些方法仍经 transport 表达,由服务端 conn.host 路由(§8.3 身份决定 host 能力面)。 */
export type HostKernelApi = Pick<KernelApi, "openFile" | "revealPath" | "dialog" | "platform" | "app" | "notify" | "window">;
/** 可远程能力面(web-service §4.3/§16.2):语义与本机/远程无关,只经 transport 表达。 */
export type CoreKernelApi = Omit<KernelApi, keyof HostKernelApi>;

declare global {
  interface Window {
    kernel: KernelApi;
    /** 拖拽/粘贴文件的绝对路径解析(preload 暴露 webUtils.getPathForFile;Electron 桌面独有,远程浏览器无)。 */
    mhdFile?: { getPathForFile(file: File): string };
  }
}

export type {
  SessionInfo, ImageInput, SessionEvent, SyncSnapshot, TreeNode,
  MessageEntry, SessionState, ModelInfo, CommandItem, NeutralMessage,
  PluginContext, PluginConfigApi, AppInfo,
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, ForkOptions, BashApi,
  FsApi, GitReadApi, GitWriteApi, LlmOneshotApi, DialogApi,
  GitChangedFile, GitStatusResult, GitLogEntry, ToolCallBlock, ThinkingContent,
  HeaderPatch, SessionToolConfig, BashResult,
  SessionStats, TokenUsage, ContextUsage, ProjectStats,
  KernelEvent, SessionMessageEvent, QuestionRequestEvent, Question, QuestionAnswer, ProcessExitEvent, RpcErrorEvent,
  PluginListItem, PluginState, PluginTier,
  KernelExtensionInfo, KernelExtensionCapabilities, SkillInfo, ManagedSkill, SkillCapabilities, SettingsItem, SettingsGroupContribution, SettingsFieldDecl,
  MessageRendererContribution, FileActionContribution, MessageActionContribution,
  AuxBlock, AuxBlockParser,
  LayoutNode, LayoutSplit, LayoutGroup, ViewInstance, OpenViewRequest, LayoutApi,
} from "@my-harness-desktop/shared";

export { RECOMMENDED_PLUGIN_TAGS, toolCallsOf, thinkingBlocksOf } from "@my-harness-desktop/shared";
export { DEFAULT_GROUP_IDS, matchComposerCommandName } from "@my-harness-desktop/shared";
export {
  GENERAL_CONFIG_PATH,
  SIDEBAR_STYLE_PRESETS, SIDEBAR_STYLE_PRESET_MAP, type SidebarStyle,
  SIDEPANEL_STYLE_PRESETS, SIDEPANEL_STYLE_PRESET_MAP, type SidepanelStyle,
  type StylePreset, type StylePresetId,
} from "@my-harness-desktop/shared";
// renderer 运行时状态(stores 实体在 api/renderer/stores,此处 re-export 保插件 import 不变)
export * from "../../../src/web/stores/ui-store";
// 会话级待执行意图(模型 pending / 排队 / 草稿 / 工具过滤)——存储走会话作用域容器,
// 消费方不再手拼 key(设计 docs/design/session-scope.md §2.6)
export * from "../../../src/web/stores/session-pending";
export { useLayoutStore, useGroupHidden } from "../../../src/web/stores/layout-store";
export { useSessionStore, initSessionStore } from "../../../src/web/stores/session-store";
export { buildToolLimitNote, stripToolLimitNote, getInflightToolCalls } from "../../../src/web/stores/session-store";
export { registerAuxParsers, unregisterAuxParsers, getAuxParsers } from "./aux-block-parsers";
export { registerComposerCommands, unregisterComposerCommands, getComposerCommands, runComposerCommandIfMatch } from "./composer-commands";
export { PluginIdContext, usePluginId } from "./plugin-id-context";
export { eventBus } from "./event-bus";
export {
  PanelRow, type PanelRowProps,
  PanelToolbar, type PanelToolbarProps,
  PanelIconButton, type PanelIconButtonProps,
  PanelSearchInput, type PanelSearchInputProps,
  PanelStatRow, type PanelStatRowProps,
  PanelCard, type PanelCardProps,
  PanelSectionTitle, type PanelSectionTitleProps,
  PanelTabs, type PanelTabsProps,
} from "./panel";
export { SettingsSection, type SettingsSectionProps } from "./settings-section";
export { ListItem, type ListItemProps } from "./list-item";
export { Section, type SectionProps } from "./widgets/section";
export { Button, type ButtonProps, type ButtonVariant } from "./widgets/button";
export { Select, type SelectProps } from "./widgets/select";
export { EmptyState, type EmptyStateProps } from "./widgets/empty-state";
export { Toast, ensureToastHost, type ToastProps } from "./widgets/toast";
// 常驻 live region 宿主：应用根挂载一次，让**第一条** toast 也能被读屏播报（见 live-region.tsx 的说明）。
export { LiveRegionHost, Announce, announceTransient } from "./widgets/live-region";
// 复制到剪贴板的统一原语（r134）：9 处各自调 navigator.clipboard 的形态收敛成一个，
// 失败时自己播报（§7.6 不许静默）、返回 boolean 供调用方驱动"已复制"状态。
export { copyToClipboard } from "./widgets/clipboard";
export { CollapsibleCardHeader, ExecutionStatus, type CollapsibleCardHeaderProps, type ExecStatus } from "./widgets/collapsible-card-header";
export { FileTree } from "./widgets/file-tree";
export { PluginIcon, resolvePluginIcon } from "./widgets/plugin-icon";
export { KernelLogo, useKernelLogo } from "./widgets/kernel-logo";
export { useKernelLogos, initKernelLogos } from "../../../src/web/stores/kernel-logos";
export { SortableList, type SortableListProps, type SortableListItemProps } from "./widgets/sortable-list";
export { Pagination, usePagination, type PaginationProps, type UsePaginationResult } from "./widgets/pagination";
export { CtxMenu, CtxMenuItem, CtxMenuSeparator } from "./widgets/context-menu";
export { InlineConfirmInput, useArmConfirm, type InlineConfirmInputProps } from "./inline-confirm";
export {
  useFileActions, invokeFileAction, fileActionInvokeChannel,
  type FileActionItem, type FileActionInvokePayload,
} from "./file-actions";
export { useFileIcons, useFileIconIndex, type FileIconItem } from "./file-icons";
export {
  useMessageActions, resolveMessageActionComponent,
  type MessageActionItem, type MessageActionProps,
} from "./message-actions";
export {
  useBlockRenderers, resolveBlockRenderer, resolveBlockRendererComponent,
  type BlockRendererItem,
} from "./block-renderers";
export { useSessionGroupings, type SessionGroupingItem } from "./session-groupings";
export { useComposerPolicies, type ComposerPolicyItem } from "./composer-policies";
export { useComposerAttachments, type ComposerAttachmentItem, type ComposerAttachmentProps } from "./composer-attachments";
export { useComposerActions, type ComposerActionItem } from "./composer-actions";
export { useComposerStats, type ComposerStatsItem } from "./composer-stats";
export { useComposerTop, type ComposerTopItem } from "./composer-top";
// 会话作用域插件测试装置(设计 §5.2):真实注册槽 + PluginIdContext wrapper,不 mock 容器。
// useSessionScopeStore/__resetScopesForTests 也经此暴露:插件测试要用**真实**容器构造前置态
// (seed 某会话的槽、复位),而插件只许 import shared + react(audit:deps 检验④)——
// 经发布面 re-export 才不违规(与 ui-store/session-pending 同一手法)。
export { ensureSlotsRegistered, pluginWrapper } from "./session-scope-testkit";
export { useSessionScopeStore, __resetScopesForTests, readTolerant } from "../../../src/web/stores/session-scope";
// 会话作用域发布面(设计 docs/design/session-scope.md §2.4)
export {
  registerSessionSlots, unregisterSessionSlots,
  useSessionScope, useSessionScopeRef, useSessionScopeAccess, useCurrentScopeKey, currentScopeKey,
  type SessionScopeAccess,
} from "./session-scope";
export { useComposerVoice, type ComposerVoiceItem, type ComposerVoiceProps } from "./composer-voice";
export { useSettingsGroups, type SettingsGroupItem } from "./settings-groups";
export { getPluginComponent, registerPluginModule, unregisterPluginModule, getLoadedPluginIds, getPluginOverlay, asReactComponent } from "./plugin-modules";
export { useCodeBlockRenderers, resolveCodeBlockRenderer, resolveCodeBlockRendererByExtension, resolveCodeBlockRendererComponent, type CodeBlockRendererItem } from "./code-block-renderers";
export { PluginOverlays } from "./plugin-overlays";
export { ErrorBoundary } from "./error-boundary";
// 流式件（诉求 15）：message-blocks 与 markdown 两条渲染路径共用一份实现，
// 避免「改一份、另一份不动」——详由见 ./stream-caret.tsx 头注释。
export { StreamingCaret, useDebouncedValue } from "./stream-caret";

// 内核管理共享 base（kernel-design-spec.md §12.4/§12.5/§12.6）：设置页三 TAB 的统一功能面骨架。
// value 与 type 分开 export：rollup 对「inline type modifier 混合 value」的 re-export 偶发丢 value，
// 分开写保证 KernelVersionPage 等运行时值一定进入产物。
export { KernelVersionPage } from "./manager/kernel-version-page";
export type { KernelVersionPageProps, KernelInstallApi } from "./manager/kernel-version-page";
export { ModelConfigPage } from "./manager/model-config-page";
export type { ModelConfigPageProps } from "./manager/model-config-page";
export { KernelConfigForm } from "./manager/kernel-config-form";
export type { KernelConfigFormProps } from "./manager/kernel-config-form";

export * from "./plugin-context";
export { KernelExtensionsPage, type KernelExtensionsPageProps } from "./kernel-extensions-page";

export interface SettingsComponentProps {
  refreshSignal: number;
  config: Record<string, unknown> | null;
  /** 本页有未保存编辑(框架 dirty 透传);测试类"只对已落盘配置有意义"的动作应据此禁用。 */
  dirty?: boolean;
  onChange: (config: Record<string, unknown>) => void;
}

export interface MessageRendererProps {
  message: NeutralMessage;
  streaming: boolean;
}

/** role → { 组件, 贡献方 pluginId }。
 *
 *  为什么必须记 pluginId:消费方渲染贡献组件时要用 PluginIdContext 包裹,组件里的
 *  usePluginId()/usePluginContext() 才能拿到**自己**的 id。composerAttachments 槽就因为
 *  消费方漏包 Provider 出过实弹 bug(review 的 BasketBar 把评论写进了 `timeline:basket`
 *  这个没人读的槽)。注册表把 pluginId 与组件绑成一对后,消费方拿到就能包、无从遗漏。 */
const messageRendererComponents = new Map<string, { comp: ComponentType<MessageRendererProps>; pluginId: string }>();

export function registerMessageRenderer(role: string, comp: ComponentType<MessageRendererProps>, pluginId = ""): void {
  messageRendererComponents.set(role, { comp, pluginId });
}

export function getMessageRenderer(role: string): { comp: ComponentType<MessageRendererProps>; pluginId: string } | undefined {
  return messageRendererComponents.get(role);
}

export function unregisterMessageRenderer(role: string): void {
  messageRendererComponents.delete(role);
}

export function registerPluginMessageRenderers(
  pluginId: string,
  module: Record<string, unknown>,
  contributes: { messageRenderers?: { role: string; component: string }[] },
): void {
  if (!contributes.messageRenderers) return;
  for (const item of contributes.messageRenderers) {
    const comp = asReactComponent(module[item.component]);
    if (comp) {
      messageRendererComponents.set(item.role, { comp: comp as ComponentType<MessageRendererProps>, pluginId });
    } else {
      console.warn(`[registerPluginMessageRenderers] 组件 ${item.component} 未在 module exports 中找到 (role=${item.role})`);
    }
  }
}

export function unregisterPluginMessageRenderers(
  contributes: { messageRenderers?: { role: string; component: string }[] },
): void {
  if (!contributes.messageRenderers) return;
  for (const item of contributes.messageRenderers) {
    messageRendererComponents.delete(item.role);
  }
}

const settingsComponents = new Map<string, ComponentType<SettingsComponentProps>>();
const sidePanelComponents = new Map<string, ComponentType<{ isActive: boolean }>>();
const sidebarComponents = new Map<string, ComponentType>();
const mainViewComponents = new Map<string, ComponentType>();
const titlebarComponents = new Map<string, ComponentType>();

export function getSettingsComponent(name: string): ComponentType<SettingsComponentProps> | undefined {
  return settingsComponents.get(name);
}
export function getSidePanelComponent(name: string): ComponentType<{ isActive: boolean }> | undefined {
  return sidePanelComponents.get(name);
}
export function getSidebarComponent(name: string): ComponentType | undefined {
  return sidebarComponents.get(name);
}
export function getMainViewComponent(name: string): ComponentType | undefined {
  return mainViewComponents.get(name);
}
export function getTitlebarComponent(name: string): ComponentType | undefined {
  return titlebarComponents.get(name);
}

const componentRegistries: Record<string, Map<string, ComponentType<any>>> = {
  settings: settingsComponents as Map<string, ComponentType<any>>,
  sidePanel: sidePanelComponents as Map<string, ComponentType<any>>,
  sidebar: sidebarComponents as Map<string, ComponentType<any>>,
  mainView: mainViewComponents,
  titlebar: titlebarComponents,
};

type SlotWithComponents = "settings" | "sidePanel" | "sidebar" | "mainView" | "titlebar";

/** settings 槽贡献项(含展示分组 tabs)的最小形状:只取注册组件需要的字段。
 *  展示分组入口(有 tabs)无自身 component,component 在各 TAB 里。 */
interface SettingsContributionLike {
  component?: string;
  tabs?: SettingsContributionLike[];
}

interface ContributesLike {
  settings?: SettingsContributionLike[];
  sidePanel?: { component: string }[];
  sidebar?: { component: string }[];
  mainView?: { component: string }[];
  titlebar?: { component: string }[];
  messageRenderers?: { role: string; component: string }[];
}

/** settings 槽的展示分组(tabs)递归展开成平铺组件名——各 TAB 叶子要注册;
 *  入口(壳)无自身 component,跳过。 */
function flatSettingsComponents(items: SettingsContributionLike[]): { component: string }[] {
  return items
    .flatMap((it) => [it, ...(it.tabs ?? [])])
    .filter((it): it is SettingsContributionLike & { component: string } => typeof it.component === "string");
}

export function registerPluginComponents(
  module: Record<string, unknown>,
  contributes: ContributesLike,
): void {
  for (const slot of ["settings", "sidePanel", "sidebar", "mainView", "titlebar"] as const) {
    const items = contributes[slot as SlotWithComponents];
    if (!items) continue;
    const registry = componentRegistries[slot];
    const flat: { component: string }[] = slot === "settings"
      ? flatSettingsComponents(items as SettingsContributionLike[])
      : (items as { component: string }[]);
    for (const item of flat) {
      const comp = asReactComponent(module[item.component]);
      if (comp) {
        registry.set(item.component, comp as ComponentType);
      } else {
        console.warn(`[registerPluginComponents] 组件 ${item.component} 未在 module exports 中找到 (slot=${slot})`);
      }
    }
  }
}

export function unregisterPluginComponents(contributes: ContributesLike): void {
  for (const slot of ["settings", "sidePanel", "sidebar", "mainView", "titlebar"] as const) {
    const items = contributes[slot as SlotWithComponents];
    if (!items) continue;
    const registry = componentRegistries[slot];
    const flat: { component: string }[] = slot === "settings"
      ? flatSettingsComponents(items as SettingsContributionLike[])
      : (items as { component: string }[]);
    for (const item of flat) {
      registry.delete(item.component);
    }
  }
}
