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

// ============ 条目 → 时间线消息映射(三层信息流) ============

/**
 * pi 会话条目(JSONL 一行)→ 时间线 NeutralMessage。
 * 三层:内容层(message/custom_message display=true 原样进)、
 * 分隔层(model_change/thinking_level_change/compaction/branch_summary/session_info
 * 映射成 role="divider" 的居中分隔线)、隐藏层(custom/label/display=false 返回 null)。
 * 结构防御式(不 import pi 类型),文件读(readSession)与事件流(entryAppended)共用。
 */
export function sessionEntryToNeutral(j: unknown): NeutralMessage | null {
  if (!j || typeof j !== "object") return null;
  const e = j as Record<string, unknown>;
  const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : undefined;

  if (e.type === "message" && e.message && typeof e.message === "object") {
    return { ...(e.message as Record<string, unknown>), timestamp: ts } as NeutralMessage;
  }
  if (e.type === "custom_message") {
    if (e.display === false) return null; // 契约:display=false 就是隐藏
    return {
      role: typeof e.customType === "string" ? e.customType : "custom_message",
      content: typeof e.content === "string" ? e.content : "",
      timestamp: ts,
    } as NeutralMessage;
  }
  if (e.type === "model_change") {
    return divider(`模型 → ${e.provider}/${e.modelId}`, "model", ts);
  }
  if (e.type === "thinking_level_change") {
    return divider(`思考强度 → ${e.thinkingLevel}`, "thinking", ts);
  }
  if (e.type === "compaction") {
    const t = typeof e.tokensBefore === "number" ? fmtTokens(e.tokensBefore) : null;
    return divider(t ? `上下文已压缩(${t} tokens)` : "上下文已压缩", "compaction", ts,
      typeof e.summary === "string" ? e.summary : undefined);
  }
  if (e.type === "branch_summary") {
    return divider("分支摘要", "branch", ts, typeof e.summary === "string" ? e.summary : undefined);
  }
  if (e.type === "session_info") {
    return typeof e.name === "string" && e.name
      ? divider(`会话重命名为 "${e.name}"`, "info", ts)
      : null;
  }
  if (e.type === "label") {
    return divider(`书签: ${typeof e.label === "string" ? e.label : ""}`, "label", ts);
  }
  // custom(扩展私有状态,如 plan-mode-state 动辄上百条,显示即刷屏)/session(文件头):隐藏
  if (e.type === "custom" || e.type === "session") return null;
  // 默认展示:未知类型(未来底座新增) → 分隔线(类型名) + 可展开原始 JSON
  return divider(String(e.type ?? "unknown"), "entry", ts, safeJson(j));
}

function divider(text: string, kind: string, timestamp?: number, detail?: string): NeutralMessage {
  return { role: "divider", kind, content: text, detail, timestamp } as NeutralMessage;
}

/** 12345 → "12.3k"。 */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 兜底展示的原始 JSON(截断 2000 字符防巨型条目)。 */
function safeJson(j: unknown): string {
  try {
    const s = JSON.stringify(j, null, 2);
    return s.length > 2000 ? s.slice(0, 2000) + "\n…(截断)" : s;
  } catch {
    return String(j);
  }
}
