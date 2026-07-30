// @pi-desktop/core —— 圆心契约的发布面(给插件 import 的包)。
//
// 依据 docs/plugins(20-guide-extension.md 等):插件只 import @pi-desktop/core
// 拿类型,不直接 import 项目内的 src/domain。
//
// 单源纪律:圆心契约只在 src/domain 定义一份,本包不重复定义、只 re-export。
// 这样 domain(项目内圆心源)改了,core(发布面)自动跟——杜绝双份漂移
// (旧版两份各自维护,SessionEvent 已发生过 domain 是精确联合、core 是宽松对象的漂移)。
// 依赖方向仍只向内:domain 不 import core,core re-export domain。
// 纯类型 + 零依赖纯函数(domain/sessionEntryToNeutral 无副作用、无外部 import)。

// 主题(Theme 类型 + token 清单 + 默认值,圆心唯一源)
export type { Theme } from "../../../src/domain/slots/theme-tokens";
export { THEME_TOKEN_SCHEMA_VERSION, THEME_TOKEN_KEYS, DERIVED_TOKENS, THEME_TOKEN_DEFAULTS, CONTRAST_PAIRS } from "../../../src/domain/slots/theme-tokens";
export type { ContrastPair } from "../../../src/domain/slots/theme-tokens";

// 会话能力契约 + 会话文件信息 + RPC 操作接口层次(sessions.ts)
export type {
  SessionInfo, ImageInput, HeaderPatch, SessionToolConfig, BashResult,
  RpcOps, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi,
  SessionsApi, FsReadApi, GitReadApi, DialogApi,
  ModelsConfig, ProviderConfig, ModelConfig,
} from "../../../src/domain/sessions";

// PluginContext 契约(context.ts)
export type { PluginConfigApi, I18nApi, PluginContext, PluginEventsApi } from "../../../src/domain/context";

// 中性事件 + 状态投影 + 条目映射(session-state.ts;sessionEntryToNeutral 是值,非 type)
export type {
  ModelInfo, SessionState, MessageEntry, TreeNode, CommandItem, NeutralMessage,
  SyncSnapshot, SessionEvent,
  TokenUsage, ContextUsage, SessionStats,
  ToolCallStart, ToolCallUpdate, ToolCallEnd,
  AgentStartEvent, AgentEndEvent, AgentSettledEvent,
  MessageStartEvent, MessageUpdateEvent, MessageEndEvent,
  EntryAppendedEvent, SessionStartEvent, ModelSelectEvent,
  CompactionStartEvent, CompactionEndEvent, QueueUpdateEvent,
  AutoRetryStartEvent, AutoRetryEndEvent,
} from "../../../src/domain/events/session-state";
export { sessionEntryToNeutral } from "../../../src/domain/events/session-state";

// 统一内核事件抽象(kernel-event.ts)
export type {
  KernelEvent, SessionMessageEvent, ExtensionUIRequestEvent,
  ProcessExitEvent, RpcErrorEvent, ExtensionUIResponse,
} from "../../../src/domain/events/kernel-event";

// 槽位贡献项 + manifest(contributions.ts)
export type {
  ThemeContribution, SettingsContribution, SidePanelContribution, SidebarContribution,
  MainViewContribution, LanguageContribution, SlotName, PluginContributes, PluginManifest,
  PluginTier, PluginState, PluginListItem, SettingsItem,
} from "../../../src/domain/contributions";

// Extension 管理 + 重启协调器类型(domain/extensions + domain/restart)
export type { ExtensionInfo, ExtensionSource } from "../../../src/domain/extensions";
export type { RestartState, RestartCoordinator, SessionStoreForRestart } from "../../../src/domain/restart";

// 技能契约(domain/skills;SkillInfo 在圆心单源,扫描实现 in application/skills)
export type { SkillInfo, ScanOptions } from "../../../src/domain/skills";

// 内置字体预设契约(domain/font-presets;stack 单源,merge 与 renderer font-presets 共用)
export { FONT_PRESETS } from "../../../src/domain/font-presets";
export { PANEL_TOKEN_KEYS, PANEL_TOKEN_DEFAULTS, type SidepanelStyle, type SidepanelStylePreset } from "../../../src/domain/panel-tokens";
