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
  /** 模型支持的输入类型(如 ["text","image"];底座 Model.input 透传)。 */
  input?: string[];
}

/** 中性 token 用量(对应底座 SessionStats.tokens)。 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** 中性上下文占用(对应底座 SessionStats.contextUsage)。 */
export interface ContextUsage {
  /** 已用 token;null 表示未知(刚压缩后、下次响应前)。 */
  tokens: number | null;
  /** 上下文窗口上限。 */
  contextWindow: number;
  /** 占用比例(0-100);null 表示 tokens 未知。 */
  percent: number | null;
}

/** 中性会话统计(对应底座 get_session_stats 返回)。 */
export interface SessionStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: TokenUsage;
  cost: number;
  contextUsage?: ContextUsage;
  /** 输出 tokens/秒(桌面端从 messageStart→messageEnd 事件流自算,底座不给)。 */
  tps?: number | null;
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

/** 中性对话消息(对应底座 get_messages 的 AgentMessage:role + content,宽松透传)。
 *  有状态对象(非纯投影):pending/stopped/error 标记驱动渲染层视觉态,
 *  id 是 patch 锚点(applyEvent 按 id 精确 patch 而非末条替换)。 */
export interface NeutralMessage {
  /** "user" | "assistant" | "toolResult" | 插件自定义类型(如 custom_message) */
  role: string;
  /** string 或内容块数组([{type:"text"|"thinking"|"toolCall",...}]) */
  content?: unknown;
  timestamp?: number;
  /** 稳定 id:patch 锚点。applyEvent 按 id 精确定位而非末条替换。
   *  底座来的消息 id = entryId(§2.3);renderer 本地乐观回显/占位用 crypto.randomUUID()。 */
  id?: string;
  /** 流式中=true(assistant 占位 + messageUpdate 期间);messageEnd 后=false。
   *  驱动光标/思考态视觉:pending 期间显思考态,messageStart 后显流式光标。 */
  pending?: boolean;
  /** 用户点停止或生成失败后=true。保留已收到的部分内容,标"已停止"提示。 */
  stopped?: boolean;
  /** 生成失败(进程 crash/RPC reject/toolCall isError)=true。驱动 inline 红条。 */
  error?: boolean;
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

export interface MessageStartEvent { type: "messageStart"; message?: NeutralMessage }
export interface MessageUpdateEvent { type: "messageUpdate"; message?: NeutralMessage }
export interface MessageEndEvent { type: "messageEnd"; message?: NeutralMessage }

export interface EntryAppendedEvent { type: "entryAppended"; entry?: unknown }
export interface SessionStartEvent {
  type: "sessionStart";
  reason?: string;
  sessionFile?: string;
}
export interface ModelSelectEvent {
  type: "modelSelect";
  model?: ModelInfo;
  source?: string;
}

export interface CompactionStartEvent { type: "compactionStart"; reason?: string }
export interface CompactionEndEvent { type: "compactionEnd"; reason?: string }

export interface QueueUpdateEvent { type: "queueUpdate"; pendingMessageCount?: number }

export interface AutoRetryStartEvent { type: "autoRetryStart"; attempt?: number }
export interface AutoRetryEndEvent { type: "autoRetryEnd"; success?: boolean }

export interface TurnStartEvent { type: "turnStart" }
export interface TurnEndEvent { type: "turnEnd" }

export interface SessionInfoChangedEvent {
  type: "sessionInfoChanged";
  sessionName?: string;
  [key: string]: unknown;
}

export interface ThinkingLevelChangedEvent {
  type: "thinkingLevelChanged";
  thinkingLevel?: string;
  [key: string]: unknown;
}

export interface ThinkingLevelSelectEvent {
  type: "thinkingLevelSelect";
  thinkingLevel?: string;
  [key: string]: unknown;
}

export type SessionEvent =
  | ToolCallStart | ToolCallUpdate | ToolCallEnd
  | AgentStartEvent | AgentEndEvent | AgentSettledEvent
  | MessageStartEvent | MessageUpdateEvent | MessageEndEvent
  | EntryAppendedEvent | SessionStartEvent | ModelSelectEvent
  | CompactionStartEvent | CompactionEndEvent
  | QueueUpdateEvent
  | AutoRetryStartEvent | AutoRetryEndEvent
  | TurnStartEvent | TurnEndEvent
  | SessionInfoChangedEvent
  | ThinkingLevelChangedEvent | ThinkingLevelSelectEvent
  | { type: string; [key: string]: unknown };

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
    return {
      role: typeof e.customType === "string" ? e.customType : "custom_message",
      content: typeof e.content === "string" ? e.content : "",
      display: e.display,
      timestamp: ts,
    } as NeutralMessage;
  }
  if (e.type === "model_change") {
    return divider("model", "timeline.modelChange", { provider: e.provider, modelId: e.modelId }, ts);
  }
  if (e.type === "thinking_level_change") {
    return divider("thinking", "timeline.thinkingLevel", { level: e.thinkingLevel }, ts);
  }
  if (e.type === "compaction") {
    const tokens = typeof e.tokensBefore === "number" ? fmtTokens(e.tokensBefore) : null;
    return divider("compaction", "timeline.compaction", tokens != null ? { tokens } : {}, ts,
      typeof e.summary === "string" ? e.summary : undefined);
  }
  if (e.type === "branch_summary") {
    return divider("branch", "timeline.branchSummary", {}, ts, typeof e.summary === "string" ? e.summary : undefined);
  }
  if (e.type === "session_info") {
    return typeof e.name === "string" && e.name
      ? divider("info", "timeline.sessionRenamed", { name: e.name }, ts)
      : null;
  }
  if (e.type === "label") {
    return divider("label", "timeline.bookmark", { label: typeof e.label === "string" ? e.label : "" }, ts);
  }
  // custom(扩展私有状态,如 plan-mode-state 动辄上百条,显示即刷屏)/session(文件头):隐藏
  if (e.type === "custom" || e.type === "session") return null;
  // 默认展示:未知类型(未来底座新增) → 分隔线(类型名) + 可展开原始 JSON
  return divider("entry", "timeline.unknownEntry", { type: String(e.type ?? "unknown") }, ts, safeJson(j));
}

/** 构造分隔线条目:圆心只产中性结构(role/kind/i18nKey/i18nArgs),文案由渲染层查 i18n。
 *  评估 P1-B1:此前 content 塞中文文案,违反"圆心不内嵌内容"(§1.2 铁律一)。
 *  现在 content 留空(渲染层按 i18nKey + i18nArgs 调 t() 翻译),key 是契约(稳定不变)。 */
function divider(kind: string, i18nKey: string, i18nArgs: Record<string, unknown>, timestamp?: number, detail?: string): NeutralMessage {
  return { role: "divider", kind, i18nKey, i18nArgs, content: "", detail, timestamp } as NeutralMessage;
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

// ============ RPC sync 路径过滤(对齐文件读路径的 sessionEntryToNeutral)============

/**
 * NeutralMessage 可见性过滤(RPC sync 路径用)。
 * 对齐 sessionEntryToNeutral 的 custom_message display=false 隐藏规则——
 * 文件读路径在 sessionEntryToNeutral 内已过滤(display=false → null),
 * RPC 路径(resync/getForkMessages)需调此函数施加同样过滤。
 */
export function isVisibleMessage(msg: NeutralMessage): boolean {
  return msg.display !== false;
}

/** 标准对话角色(用户可合法重复发送相同内容)。圆心只含中性角色,
 *  不感知具体插件业务角色(评估 P1-B2:此前含 bashExecution,是某个插件的渲染角色泄漏进圆心,
 *  违反"内核不内嵌业务分支"§1.2)。custom_message 衍生角色(含 bashExecution)走非标准全量去重。 */
const STANDARD_ROLES = new Set(["user", "assistant", "toolResult", "divider"]);

/**
 * 消息去重:防御底座重复写入。
 * - 标准角色(user/assistant/toolResult/divider):仅相邻去重(用户可合法重发相同消息)
 * - 非标准角色(custom_message 衍生,如 bashExecution/multi-agent-dashboard/loop-planning):全量去重
 *   (底座在同一会话中多次注入相同上下文,非相邻也属冗余)
 */
export function deduplicateAdjacent(messages: NeutralMessage[]): NeutralMessage[] {
  const seen = new Set<string>();
  const out: NeutralMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    const isAdjacentDup = prev && prev.role === msg.role && sameContent(prev.content, msg.content);
    if (isAdjacentDup) continue;
    if (!STANDARD_ROLES.has(msg.role)) {
      const key = `${msg.role}::${contentKey(msg.content)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(msg);
  }
  return out;
}

/** content 比较:NeutralMessage.content 是 unknown(string 或内容块数组),统一比较。 */
function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") return a === b;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** content → 去重 key(string 原样,其他 JSON 序列化)。 */
function contentKey(content: unknown): string {
  if (typeof content === "string") return content;
  try { return JSON.stringify(content); } catch { return String(content); }
}
