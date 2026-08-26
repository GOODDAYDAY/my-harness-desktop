import type { ComponentType } from "react";
import type {
  Theme, PluginListItem, KernelExtensionInfo, SkillInfo, SkillCapabilities, SettingsItem, SettingsGroupContribution,
  SessionInfo, SessionEvent, SyncSnapshot, KernelEvent, QuestionRequestEvent, Question, QuestionAnswer, HeaderPatch, SessionToolConfig, SessionModelPrefs, KnownToolInfo,
  NeutralMessage, FileTreeNode, ReadDirTreeOptions, ProjectStats, SessionBusMessage,
  GitStatusResult, GitLogEntry, KernelStatusView, KernelVersionApi, LineageTree, Anchor, ModelInfo, KernelId, KernelLogo,
  DshModelSpec, DshProvider, DshDefaultModel,
  KernelModelsApi, KernelConfigApi,
} from "@my-harness-desktop/contract";
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
    sidebar: () => Promise<{ id: string; title: string; component: string; pluginId: string }[]>;
    mainView: () => Promise<{ id: string; component: string; pluginId: string }[]>;
    titlebar: () => Promise<{ id: string; component: string; pluginId: string }[]>;
    fileActions: () => Promise<{ id: string; labelKey: string; icon?: string; when?: { target?: "file" | "dir" | "both" }; pluginId: string }[]>;
    fileIcons: () => Promise<{ id: string; icon: string; extensions?: string[]; filenames?: string[]; color?: string; pluginId: string }[]>;
    messageActions: () => Promise<{ id: string; component: string; placement?: "left" | "right"; when?: { role?: string[] }; order?: number; pluginId: string }[]>;
    blockRenderers: () => Promise<{ id: string; block: string; names?: string[]; component: string; order?: number; pluginId: string }[]>;
    sessionGroupings: () => Promise<{ id: string; parentPathKey: string; childLabelKey?: string; childIcon?: string; order?: number; pluginId: string }[]>;
    composerPolicies: () => Promise<{ id: string; customKey: string; readonlyMessageKey?: string; order?: number; pluginId: string }[]>;
    composerAttachments: () => Promise<{ id: string; component: string; order?: number; pluginId: string }[]>;
    composerActions: () => Promise<{ id: string; component: string; order?: number; pluginId: string }[]>;
    composerStats: () => Promise<{ id: string; component: string; order?: number; pluginId: string }[]>;
    codeBlockRenderers: () => Promise<{ id: string; languages: string[]; component: string; order?: number; pluginId: string }[]>;
    settingsGroups: () => Promise<(SettingsGroupContribution & { pluginId: string })[]>;
  };
  /** 内核版本管理(统一对外面,按 KernelId 键控):pi/dsh 各一个 KernelVersionApi。 */
  kernels: Record<KernelId, KernelVersionApi>;
  /** 内核身份标(logo)取回:每个内核在自己适配器声明,壳经此取回渲染(不硬编码)。 */
  kernelLogos: { get: (kernel: KernelId) => Promise<KernelLogo> };
  dshModels: {
    get: () => Promise<DshProvider[]>;
    set: (provider: string, detail: Omit<DshProvider, "provider">) => Promise<DshProvider[]>;
    removeProvider: (provider: string) => Promise<DshProvider[]>;
    renameProvider: (oldId: string, newId: string) => Promise<DshProvider[]>;
    getDefault: () => Promise<DshDefaultModel | null>;
    setDefault: (sel: DshDefaultModel) => Promise<DshDefaultModel | null>;
    test: (cwd: string, provider: string, modelId: string) => Promise<{ ok: boolean; error?: string }>;
  };
  /** 中性内核管理 API：模型页(kernel-design-spec.md §12.5)。 */
  kernelModels: { pi: KernelModelsApi; dsh: KernelModelsApi };
  /** 中性内核原生配置 API(kernel 配置 TAB 用):pi/dsh 各一个适配器。 */
  kernelConfig: { pi: KernelConfigApi; dsh: KernelConfigApi };
  dshSettings: {
    get: () => Promise<Record<string, unknown>>;
    set: (obj: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  piSettings: {
    get: () => Promise<Record<string, unknown>>;
    set: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
    schema: () => Promise<{ key: string; type: string }[]>;
  };
  models: {
    get: <T>() => Promise<T>;
    set: <T>(config: T) => Promise<T>;
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
    deleteSessions: (paths: string[]) => Promise<{ ok: boolean }>;
    list: (cwd: string) => Promise<SessionInfo[]>;
    projectStats: (cwd: string) => Promise<ProjectStats>;
    getTree: (sessionId: string) => Promise<LineageTree>;
    bookmark: (lineageId: string, boundary: string) => Promise<Anchor>;
    resume: (anchor: Anchor) => Promise<string>;
    deleteBookmark: (anchor: Anchor) => Promise<void>;
    switchKernel: (target: KernelId) => Promise<void>;
    getCapabilities: () => Promise<{ kernel: KernelId | null; locked: boolean; piExtension: boolean; dshExtension: boolean }>;
    onEvent: (cb: (event: SessionEvent) => void) => () => void;
    onKernelEvent: (cb: (event: KernelEvent) => void) => () => void;
    onQuestion: (cb: (req: QuestionRequestEvent) => void) => () => void;
    answerQuestion: (requestId: string, answers: QuestionAnswer[]) => Promise<void>;
    listTools: () => Promise<KnownToolInfo[] | null>;
    onSnapshot: (cb: (snapshot: SyncSnapshot) => void) => () => void;
    prompt: (text: string, images?: { data: string; mimeType: string; name?: string }[], display?: { image?: { src: string; title?: string } }, prefs?: SessionModelPrefs) => Promise<void>;
    abort: () => Promise<void>;
    continue: () => Promise<void>;
    getModels: () => Promise<unknown[]>;
    setModel: (provider: string, modelId: string, kernel: KernelId) => Promise<void>;
    /** 模型连通性测试(内核隔离临时会话 ping;对应 domain ModelApi.test) */
    testModel: (cwd: string, provider: string, modelId: string, kernel: KernelId) => Promise<{ ok: boolean; error?: string }>;
    setThinkingLevel: (level: string) => Promise<void>;
    fork: (parentLineageId: string, boundary?: string) => Promise<string>;
    copySession: (srcPath: string, targetPath: string) => Promise<void>;
    getStats: () => Promise<unknown>;
    pi: {
      steer: (text: string, images?: { data: string; mimeType: string; name?: string }[]) => Promise<void>;
      followUp: (text: string, images?: { data: string; mimeType: string; name?: string }[]) => Promise<void>;
      abortRetry: () => Promise<void>;
      cycleModel: () => Promise<void>;
      getThinkingLevels: () => Promise<string[]>;
      cycleThinkingLevel: () => Promise<void>;
      forkFromSession: (cwd: string, srcPath: string, entryId: string) => Promise<void>;
      clone: () => Promise<void>;
      getForkMessages: (entryId: string) => Promise<unknown[]>;
      compact: (customInstructions?: string) => Promise<void>;
      setAutoCompaction: (enabled: boolean) => Promise<void>;
      setAutoRetry: (enabled: boolean) => Promise<void>;
      exportHtml: (outputPath?: string) => Promise<string>;
      getLastAssistantText: () => Promise<string>;
      setSteeringMode: (mode: "all" | "one-at-a-time") => Promise<void>;
      setFollowUpMode: (mode: "all" | "one-at-a-time") => Promise<void>;
    };
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
    tapStop: (pluginId: string, tapId: string) => Promise<unknown>;
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
    list: (cwd: string) => Promise<SkillInfo[]>;
    getCapabilities: () => Promise<SkillCapabilities>;
    setEnabled: (skill: SkillInfo, enabled: boolean) => Promise<void>;
    setModelInvocable: (skill: SkillInfo, value: boolean) => Promise<void>;
    getBundled: () => Promise<{ path: string; enabled: boolean }>;
    setBundledEnabled: (enabled: boolean) => Promise<void>;
    watch: (cwd: string, onChanged: () => void) => () => void;
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
  }
}

export type {
  SessionInfo, ImageInput, SessionEvent, SyncSnapshot, TreeNode,
  MessageEntry, SessionState, ModelInfo, CommandItem, NeutralMessage,
  PluginContext, PluginConfigApi, AppInfo,
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, PiExtensions, BashApi,
  FsApi, GitReadApi, GitWriteApi, LlmOneshotApi, DialogApi,
  GitChangedFile, GitStatusResult, GitLogEntry, ToolCallBlock, ThinkingContent,
  HeaderPatch, SessionToolConfig, BashResult,
  SessionStats, TokenUsage, ContextUsage, ProjectStats,
  KernelEvent, SessionMessageEvent, QuestionRequestEvent, Question, QuestionAnswer, ProcessExitEvent, RpcErrorEvent,
  PluginListItem, PluginState, PluginTier,
  KernelExtensionInfo, SkillInfo, SkillCapabilities, SettingsItem, SettingsGroupContribution, SettingsFieldDecl,
  MessageRendererContribution, FileActionContribution, MessageActionContribution,
  AuxBlock, AuxBlockParser,
  LayoutNode, LayoutSplit, LayoutGroup, ViewInstance, OpenViewRequest, LayoutApi,
} from "@my-harness-desktop/contract";

export { RECOMMENDED_PLUGIN_TAGS, toolCallsOf, thinkingBlocksOf } from "@my-harness-desktop/contract";
export { DEFAULT_GROUP_IDS } from "@my-harness-desktop/contract";
export {
  GENERAL_CONFIG_PATH,
  SIDEBAR_STYLE_PRESETS, SIDEBAR_STYLE_PRESET_MAP, type SidebarStyle,
  SIDEPANEL_STYLE_PRESETS, SIDEPANEL_STYLE_PRESET_MAP, type SidepanelStyle,
  type StylePreset, type StylePresetId,
} from "@my-harness-desktop/contract";
// renderer 运行时状态(stores 实体在 api/renderer/stores,此处 re-export 保插件 import 不变)
export * from "../../../src/api/renderer/stores/ui-store";
export { useLayoutStore, useGroupHidden } from "../../../src/api/renderer/stores/layout-store";
export { useSessionStore, initSessionStore } from "../../../src/api/renderer/stores/session-store";
export { buildToolLimitNote, stripToolLimitNote } from "../../../src/api/renderer/stores/session-store";
export { registerAuxParsers, unregisterAuxParsers, getAuxParsers } from "./aux-block-parsers";
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
export { Toast, type ToastProps } from "./widgets/toast";
export { FileTree } from "./widgets/file-tree";
export { PluginIcon, resolvePluginIcon } from "./widgets/plugin-icon";
export { KernelLogo, useKernelLogo } from "./widgets/kernel-logo";
export { useKernelLogos, initKernelLogos } from "../../../src/api/renderer/stores/kernel-logos";
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
export { useSettingsGroups, type SettingsGroupItem } from "./settings-groups";
export { getPluginComponent, registerPluginModule, unregisterPluginModule, getLoadedPluginIds, getPluginOverlay, asReactComponent } from "./plugin-modules";
export { useCodeBlockRenderers, resolveCodeBlockRenderer, resolveCodeBlockRendererByExtension, resolveCodeBlockRendererComponent, type CodeBlockRendererItem } from "./code-block-renderers";
export { PluginOverlays } from "./plugin-overlays";
export { ErrorBoundary } from "./error-boundary";

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

const messageRendererComponents = new Map<string, ComponentType<MessageRendererProps>>();

export function registerMessageRenderer(role: string, comp: ComponentType<MessageRendererProps>): void {
  messageRendererComponents.set(role, comp);
}

export function getMessageRenderer(role: string): ComponentType<MessageRendererProps> | undefined {
  return messageRendererComponents.get(role);
}

export function unregisterMessageRenderer(role: string): void {
  messageRendererComponents.delete(role);
}

export function registerPluginMessageRenderers(
  module: Record<string, unknown>,
  contributes: { messageRenderers?: { role: string; component: string }[] },
): void {
  if (!contributes.messageRenderers) return;
  for (const item of contributes.messageRenderers) {
    const comp = asReactComponent(module[item.component]);
    if (comp) {
      messageRendererComponents.set(item.role, comp as ComponentType<MessageRendererProps>);
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
