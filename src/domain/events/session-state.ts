// 圆心:中性事件 + 状态投影类型 —— domain/events,零外部依赖。
//
// 依据 docs/structure/16 §3.3 + docs/modules/02 §10.2.2。
// RPC 适配层把 pi 的 AgentSessionEvent 翻译成这些中性类型,圆心不感知 pi 协议。
// 插件经 PluginContext.events.on 收到的是这里的 SessionEvent(不是 pi 的)。

/** 中性模型信息(对应底座 Model)。 */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** 中性会话状态(对应底座 RpcSessionState)。 */
export interface SessionState {
  model?: ModelInfo;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

/** 中性消息条目(对应底座 SessionEntry)。 */
export interface MessageEntry {
  id: string;
  type: string;
  content?: unknown;
  toolCalls?: unknown[];
  toolCallId?: string;
  timestamp?: number;
}

/** 中性会话树节点(对应底座 SessionTreeNode)。 */
export interface TreeNode {
  entryId: string;
  children?: TreeNode[];
  isLeaf?: boolean;
  label?: string;
}

/** 中性命令项(对应底座 RpcSlashCommand)。 */
export interface CommandItem {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

/** 中性对话消息(对应底座 get_messages 的 AgentMessage:role + content,宽松透传)。 */
export interface NeutralMessage {
  /** "user" | "assistant" | "toolResult" | 插件自定义类型(如 custom_message) */
  role: string;
  /** string 或内容块数组([{type:"text"|"thinking"|"toolCall",...}]) */
  content?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

/** resync 一次拿到的全部同步数据(中性类型)。 */
export interface SyncSnapshot {
  state: SessionState;
  entries: MessageEntry[];
  /** 对话消息(get_messages,时间线数据源;entries 是会话树条目元数据,勿混用) */
  messages: NeutralMessage[];
  tree: TreeNode[];
  commands: CommandItem[];
  leafId: string | null;
}

// ============ 中性事件联合类型(SessionEvent)============

export interface ToolCallStart {
  type: "toolCallStart";
  toolCallId: string;
  toolName: string;
  args?: unknown;
}
export interface ToolCallUpdate {
  type: "toolCallUpdate";
  toolCallId: string;
  partialResult?: unknown;
}
export interface ToolCallEnd {
  type: "toolCallEnd";
  toolCallId: string;
  result?: unknown;
  isError?: boolean;
}

export interface AgentStartEvent { type: "agentStart" }
export interface AgentEndEvent { type: "agentEnd"; messages?: unknown[] }
export interface AgentSettledEvent { type: "agentSettled" }

export interface MessageStartEvent { type: "messageStart"; message?: unknown }
export interface MessageUpdateEvent { type: "messageUpdate"; message?: unknown }
export interface MessageEndEvent { type: "messageEnd"; message?: unknown }

export interface EntryAppendedEvent { type: "entryAppended"; entry?: unknown }
export interface SessionStartEvent { type: "sessionStart"; reason?: string }
export interface ModelSelectEvent { type: "modelSelect"; model?: unknown; source?: string }

export interface CompactionStartEvent { type: "compactionStart"; reason?: string }
export interface CompactionEndEvent { type: "compactionEnd"; reason?: string }

export interface QueueUpdateEvent { type: "queueUpdate"; pendingMessageCount?: number }

export interface AutoRetryStartEvent { type: "autoRetryStart"; attempt?: number }
export interface AutoRetryEndEvent { type: "autoRetryEnd"; success?: boolean }

/** 圆心中性事件联合(翻译后,插件收的是这个)。 */
export type SessionEvent =
  | ToolCallStart | ToolCallUpdate | ToolCallEnd
  | AgentStartEvent | AgentEndEvent | AgentSettledEvent
  | MessageStartEvent | MessageUpdateEvent | MessageEndEvent
  | EntryAppendedEvent | SessionStartEvent | ModelSelectEvent
  | CompactionStartEvent | CompactionEndEvent
  | QueueUpdateEvent
  | AutoRetryStartEvent | AutoRetryEndEvent
  | { type: string; [key: string]: unknown }; // 兜底:未识别事件原样透传
