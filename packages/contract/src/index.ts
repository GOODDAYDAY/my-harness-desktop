// @my-harness-desktop/contract —— 圆心契约的发布面(给插件 import 的包)。
//
// 依据 docs/plugins(20-guide-extension.md 等):插件只 import @my-harness-desktop/contract
// 拿类型,不直接 import 项目内的 src/domain。
//
// 单源纪律:圆心契约只在 src/domain 定义一份,本包不重复定义、只 re-export。
// 这样 domain(项目内圆心源)改了,core(发布面)自动跟——杜绝双份漂移
// (旧版两份各自维护,SessionEvent 已发生过 domain 是精确联合、core 是宽松对象的漂移)。
// 依赖方向仍只向内:domain 不 import core,core re-export domain。
// 纯类型 + 零依赖纯函数(domain/sessionEntryToNeutral 无副作用、无外部 import)。

// 主题(Theme 类型 + token 清单 + 默认值,圆心唯一源)
export type { Theme } from "@my-harness-desktop/shared";
export { THEME_TOKEN_SCHEMA_VERSION, THEME_TOKEN_KEYS, DERIVED_TOKENS, THEME_TOKEN_DEFAULTS, CONTRAST_PAIRS } from "@my-harness-desktop/shared";
export type { ContrastPair } from "@my-harness-desktop/shared";

// 会话能力契约 + 会话文件信息 + RPC 操作接口层次(sessions.ts)
export type {
  SessionInfo, SessionDetail, ImageInput, HeaderPatch, SessionToolConfig, KnownToolInfo, BashResult,
  RpcOps, MessagingApi, ModelApi, SessionTreeApi, PiExtensions, BashApi,
  SessionsApi, FsApi, GitReadApi, GitWriteApi, LlmOneshotApi, DialogApi,
  GitChangedFile, GitStatusResult, GitLogEntry,
  FileTreeNode, ReadDirTreeOptions,
  SessionModelPrefs,
  SessionRole,
} from "@my-harness-desktop/shared";
// 内核 lineage 契约(§2.5):SessionsApi.getTree/bookmark/resume 的返回类型,插件经 contract 拿类型。
export type { Lineage, LineageFork, LineageTree, Anchor, BoundaryRef } from "@my-harness-desktop/shared";
// 内核层圆心契约(kernel-layer.md):BaseBackend(后端接口)+ BackendFactory(工厂接口)+ KernelModelSource(模型源)+ KernelId(内核身份单源)。
export type { BaseBackend, BackendCreateOptions, BackendFactory, KernelModelSource } from "@my-harness-desktop/shared";
export { projectLineageTree } from "@my-harness-desktop/shared";
export type { KernelId, KernelLogo } from "@my-harness-desktop/shared";
export { KERNEL_IDS } from "@my-harness-desktop/shared";
// 会话级中立坐标系(session-neutral-layer.md):中立会话身份/锚点/树/模型引用
export type {
  NeutralSessionId, NeutralAnchor, NeutralSession,
  NeutralSessionHeader, NeutralLineage, NeutralEntry, NeutralModelRef,
} from "@my-harness-desktop/shared";
export { neutralEntryId } from "@my-harness-desktop/shared";
// 会话头 model 域(会话级模型/思考深度,设计 docs/design/session-model-config.md)
export { SESSION_MODEL_PREFS_KEY, parseSessionModelPrefs } from "@my-harness-desktop/shared";
// 会话级角色卡(身份):类型 + roleToPrompt(拼 system prompt 文本,内联作 --append-system-prompt 的值)
export { roleToPrompt } from "@my-harness-desktop/shared";

// 会话名截断/派生纯函数(自动命名、打开补命名、展示层兜底共用的唯一实现;domain 零依赖纯函数)
export { SESSION_NAME_DISPLAY_MAX, truncateSessionName, messageContentText, contentHashOf, deriveSessionTitle } from "@my-harness-desktop/shared";
// cwd 桶名纯函数(会话分桶规则唯一源;application 文件扫描与插件分桶共用)
export { cwdToBucketName } from "@my-harness-desktop/shared";
// 自定义顺序归位(拖拽排序插件共用的唯一实现;domain 零依赖纯函数)
export { applyCustomOrder } from "@my-harness-desktop/shared";
// 会话工作阶段状态(设计 docs/design/session-working-phase.md;timeline 底部指示与 sessions-list 行图标共用)
export type { WorkingPhase, PhaseOverlay } from "@my-harness-desktop/shared";
export { phaseFromMessage, phaseFromView, advancePhase } from "@my-harness-desktop/shared";
// 跨平台路径取 basename(projects/file-tree/file-preview 共用;同时按 / 与 \ 切,不判平台)
export { pathBasename } from "@my-harness-desktop/shared";

// PluginContext 契约(context.ts)
export type { PluginConfigApi, I18nApi, PluginContext, PluginEventsApi, AppInfo, KernelStatusView, KernelVersionApi, DshModelSpec, DshProvider, DshDefaultModel, NeutralModel, NeutralProvider, NeutralDefaultModel, KernelModelConfig, KernelModelsApi, KernelModelsCapabilities, KernelConfigField, KernelConfigApi } from "@my-harness-desktop/shared";
export { DSH_OFFICIAL_PROVIDER } from "@my-harness-desktop/shared";

// channel 可读描述 + 枚举项(domain/channel-meta.ts;快捷键/命令面板类插件动态列出事件的契约)
export type { ChannelMeta, ChannelInfo } from "@my-harness-desktop/shared";

// 中性事件 + 状态投影 + 条目映射(session-state.ts;sessionEntryToNeutral 是值,非 type)
export type {
  ModelInfo, SessionState, MessageEntry, TreeNode, CommandItem, NeutralMessage,
  SyncSnapshot, SessionEvent, ToolCallBlock,
  TokenUsage, ContextUsage, SessionStats, ProjectStats, TurnUsage,
  ToolCallStart, ToolCallUpdate, ToolCallEnd,
  AgentStartEvent, AgentEndEvent, AgentSettledEvent,
  MessageStartEvent, MessageUpdateEvent, MessageEndEvent,
  EntryAppendedEvent, SessionStartEvent, ModelSelectEvent,
  CompactionStartEvent, CompactionEndEvent, QueueUpdateEvent,
  AutoRetryStartEvent, AutoRetryEndEvent,
} from "@my-harness-desktop/shared";
// toolCall/thinking 内容块解析纯函数(timeline 渲染/git-review 轮次追踪共用的唯一实现)
export { toolCallsOf, thinkingBlocksOf } from "@my-harness-desktop/shared";
export type { ThinkingContent } from "@my-harness-desktop/shared";
export { sessionEntryToNeutral } from "@my-harness-desktop/shared";

// 统一内核事件抽象(kernel-event.ts)
export type {
  KernelEvent, SessionMessageEvent, QuestionRequestEvent, Question, QuestionAnswer,
  ProcessExitEvent, RpcErrorEvent,
} from "@my-harness-desktop/shared";

// Session Bus 中性契约(events/session-bus.ts:信封/tap/地址 helper/BusApi)
export type {
  SessionBusMessage, SessionDonePayload, SessionDoneStatus, TapFilter, BusTap, BusApi,
} from "@my-harness-desktop/shared";
export {
  LIFECYCLE_EVENT_TYPES, sessionAddress, channelAddress, pluginAddress,
  isSessionAddress, isChannelAddress, isPluginAddress, sessionKeyOf, channelNameOf,
} from "@my-harness-desktop/shared";

// 槽位贡献项 + manifest(contributions.ts)
export type {
  ThemeContribution, SettingsContribution, SettingsGroupContribution, SettingsFieldDecl, SidePanelContribution, SidebarContribution,
  MainViewContribution, LanguageContribution, MessageRendererContribution, FileActionContribution, FileIconContribution, MessageActionContribution, BlockRendererContribution, SessionGroupingContribution, ComposerPolicyContribution, ComposerAttachmentContribution, ComposerActionContribution, ComposerStatsContribution, ComposerAttachmentPayload, CodeBlockRendererContribution, FontPresetContribution, SlotName, PluginContributes, PluginManifest,
  PluginTier, PluginState, PluginListItem, SettingsItem,
} from "@my-harness-desktop/shared";
// 插件分类 tag:推荐词表 + 推导/解析纯函数(值导出,同 THEME_TOKEN_DEFAULTS 先例)
export { RECOMMENDED_PLUGIN_TAGS, derivePluginTags, resolvePluginTags } from "@my-harness-desktop/shared";

// fileIcons 槽解析纯函数(domain 零依赖;文件树按行解析图标的唯一实现)
export { buildFileIconIndex, resolveFileIcon, type FileIconIndex } from "@my-harness-desktop/shared";

// 内核拓展管理 + 重启协调器类型(domain/extensions + domain/restart)
export type { KernelExtensionInfo, KernelExtensionCapabilities, KernelExtensionMutationResult, KernelExtensionSource } from "@my-harness-desktop/shared";
export type { RestartState, RestartCoordinator, SessionStoreForRestart } from "@my-harness-desktop/shared";

// 技能契约(domain/skills;SkillInfo/SkillProvider/SkillCapabilities 在圆心单源)
export type { SkillInfo, SkillProvider, SkillCapabilities } from "@my-harness-desktop/shared";

// 结构化块机制(domain/aux-blocks;解析纯函数单源,插件 parser 与 timeline 消费共用)
export type { AuxBlock, AuxBlockParser } from "@my-harness-desktop/shared";
export { parseUserBlocks } from "@my-harness-desktop/shared";

// 动态布局引擎中性类型 + 常量(layout.ts)
export type {
  LayoutNode, LayoutSplit, LayoutGroup, ViewInstance, OpenViewRequest, LayoutApi,
} from "@my-harness-desktop/shared";
export {
  ROOT_SPLIT_ID, DEFAULT_GROUP_IDS, SHELL_VIEW_PREFIX, SLOT_VIEW_PREFIX,
} from "@my-harness-desktop/shared";

// 配置文件路径契约(原 packages/react/paths;消费方 debug-bar/timeline/ui-store 统一引用)
export { GENERAL_CONFIG_PATH, MODELS_CONFIG_PATH } from "./paths";

// 样式预设清单契约(原 packages/react/style-presets;唯一 TS 源,样式内容真源在 api/renderer/index.css)
export {
  SIDEBAR_STYLE_PRESETS, SIDEBAR_STYLE_PRESET_MAP, type SidebarStyle,
  SIDEPANEL_STYLE_PRESETS, SIDEPANEL_STYLE_PRESET_MAP, type SidepanelStyle,
  type StylePreset, type StylePresetId,
} from "./style-presets";
