// @pi-desktop/contract —— 圆心契约的发布面(给插件 import 的包)。
//
// 依据 docs/plugins(20-guide-extension.md 等):插件只 import @pi-desktop/contract
// 拿类型,不直接 import 项目内的 src/domain。
//
// 单源纪律:圆心契约只在 src/domain 定义一份,本包不重复定义、只 re-export。
// 这样 domain(项目内圆心源)改了,core(发布面)自动跟——杜绝双份漂移
// (旧版两份各自维护,SessionEvent 已发生过 domain 是精确联合、core 是宽松对象的漂移)。
// 依赖方向仍只向内:domain 不 import core,core re-export domain。
// 纯类型 + 零依赖纯函数(domain/sessionEntryToNeutral 无副作用、无外部 import)。

// 主题(Theme 类型 + token 清单 + 默认值,圆心唯一源)
export type { Theme } from "../../../src/core/domain/slots/theme-tokens";
export { THEME_TOKEN_SCHEMA_VERSION, THEME_TOKEN_KEYS, DERIVED_TOKENS, THEME_TOKEN_DEFAULTS, CONTRAST_PAIRS } from "../../../src/core/domain/slots/theme-tokens";
export type { ContrastPair } from "../../../src/core/domain/slots/theme-tokens";

// 会话能力契约 + 会话文件信息 + RPC 操作接口层次(sessions.ts)
export type {
  SessionInfo, SessionDetail, ImageInput, HeaderPatch, SessionToolConfig, BashResult,
  RpcOps, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi,
  SessionsApi, FsApi, GitReadApi, GitWriteApi, LlmOneshotApi, DialogApi,
  GitChangedFile, GitStatusResult, GitLogEntry,
  FileTreeNode, ReadDirTreeOptions,
  ModelsConfig, ProviderConfig, ModelConfig,
  SessionModelPrefs,
} from "../../../src/core/domain/sessions";
// 会话头 model 域(会话级模型/思考深度,设计 docs/design/session-model-config.md)
export { SESSION_MODEL_PREFS_KEY, parseSessionModelPrefs } from "../../../src/core/domain/sessions";

// 会话名截断/派生纯函数(自动命名、打开补命名、展示层兜底共用的唯一实现;domain 零依赖纯函数)
export { SESSION_NAME_DISPLAY_MAX, truncateSessionName, messageContentText, deriveSessionTitle } from "../../../src/core/domain/sessions";
// cwd 桶名纯函数(会话分桶规则唯一源;application 文件扫描与插件分桶共用)
export { cwdToBucketName } from "../../../src/core/domain/sessions";
// 自定义顺序归位(拖拽排序插件共用的唯一实现;domain 零依赖纯函数)
export { applyCustomOrder } from "../../../src/core/domain/custom-order";

// PluginContext 契约(context.ts)
export type { PluginConfigApi, I18nApi, PluginContext, PluginEventsApi, AppInfo, KernelStatusView } from "../../../src/core/domain/context";

// 中性事件 + 状态投影 + 条目映射(session-state.ts;sessionEntryToNeutral 是值,非 type)
export type {
  ModelInfo, SessionState, MessageEntry, TreeNode, CommandItem, NeutralMessage,
  SyncSnapshot, SessionEvent, ToolCallBlock,
  TokenUsage, ContextUsage, SessionStats, ProjectStats,
  ToolCallStart, ToolCallUpdate, ToolCallEnd,
  AgentStartEvent, AgentEndEvent, AgentSettledEvent,
  MessageStartEvent, MessageUpdateEvent, MessageEndEvent,
  EntryAppendedEvent, SessionStartEvent, ModelSelectEvent,
  CompactionStartEvent, CompactionEndEvent, QueueUpdateEvent,
  AutoRetryStartEvent, AutoRetryEndEvent,
} from "../../../src/core/domain/events/session-state";
// toolCall 内容块解析纯函数(timeline 渲染/git-review 轮次追踪共用的唯一实现)
export { toolCallsOf } from "../../../src/core/domain/events/session-state";
export { sessionEntryToNeutral } from "../../../src/core/domain/events/session-state";

// 统一内核事件抽象(kernel-event.ts)
export type {
  KernelEvent, SessionMessageEvent, ExtensionUIRequestEvent,
  ProcessExitEvent, RpcErrorEvent, ExtensionUIResponse,
} from "../../../src/core/domain/events/kernel-event";

// Session Bus 中性契约(events/session-bus.ts:信封/tap/地址 helper/BusApi)
export type {
  SessionBusMessage, SessionDonePayload, SessionDoneStatus, TapFilter, BusTap, BusApi,
} from "../../../src/core/domain/events/session-bus";
export {
  LIFECYCLE_EVENT_TYPES, sessionAddress, channelAddress, pluginAddress,
  isSessionAddress, isChannelAddress, isPluginAddress, sessionKeyOf, channelNameOf,
} from "../../../src/core/domain/events/session-bus";

// 槽位贡献项 + manifest(contributions.ts)
export type {
  ThemeContribution, SettingsContribution, SidePanelContribution, SidebarContribution,
  MainViewContribution, LanguageContribution, MessageRendererContribution, FileActionContribution, FileIconContribution, MessageActionContribution, SessionGroupingContribution, ComposerPolicyContribution, SlotName, PluginContributes, PluginManifest,
  PluginTier, PluginState, PluginListItem, SettingsItem,
} from "../../../src/core/domain/contributions";
// 插件分类 tag:推荐词表 + 推导/解析纯函数(值导出,同 FONT_PRESETS 先例)
export { RECOMMENDED_PLUGIN_TAGS, derivePluginTags, resolvePluginTags } from "../../../src/core/domain/contributions";

// fileIcons 槽解析纯函数(domain 零依赖;文件树按行解析图标的唯一实现)
export { buildFileIconIndex, resolveFileIcon, type FileIconIndex } from "../../../src/core/domain/file-icons";

// Extension 管理 + 重启协调器类型(domain/extensions + domain/restart)
export type { ExtensionInfo, ExtensionSource } from "../../../src/core/domain/extensions";
export type { RestartState, RestartCoordinator, SessionStoreForRestart } from "../../../src/core/domain/restart";

// 技能契约(domain/skills;SkillInfo 在圆心单源,扫描实现 in application/skills)
export type { SkillInfo, ScanOptions } from "../../../src/core/domain/skills";

// 内置字体预设契约(domain/font-presets;stack 单源,merge 与 renderer font-presets 共用)
export { FONT_PRESETS } from "../../../src/core/domain/font-presets";

// 动态布局引擎中性类型 + 常量(layout.ts)
export type {
  LayoutNode, LayoutSplit, LayoutGroup, ViewInstance, OpenViewRequest, LayoutApi,
} from "../../../src/core/domain/layout";
export {
  ROOT_SPLIT_ID, DEFAULT_GROUP_IDS, SHELL_VIEW_PREFIX, SLOT_VIEW_PREFIX,
} from "../../../src/core/domain/layout";

// 配置文件路径契约(原 packages/react/paths;消费方 debug-bar/timeline/ui-store 统一引用)
export { GENERAL_CONFIG_PATH } from "./paths";

// 样式预设清单契约(原 packages/react/style-presets;唯一 TS 源,样式内容真源在 api/renderer/index.css)
export {
  SIDEBAR_STYLE_PRESETS, SIDEBAR_STYLE_PRESET_MAP, type SidebarStyle,
  SIDEPANEL_STYLE_PRESETS, SIDEPANEL_STYLE_PRESET_MAP, type SidepanelStyle,
  type StylePreset, type StylePresetId,
} from "./style-presets";
