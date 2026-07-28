// 底座类型 → 圆心中性类型映射 —— gateway。
//
// 依据 docs/modules/02 §4.4.1 + docs/structure/16 §3.4。
// 把 pi 的 RpcSessionState/SessionEntry/SessionTreeNode/RpcSlashCommand/Model
// 映射成圆心的 SessionState/MessageEntry/TreeNode/CommandItem/ModelInfo。
import type {
  RpcSessionState,
  SessionEntry,
  SessionTreeNode,
  RpcSlashCommand,
  Model,
} from "./protocol/rpc-types";
import type {
  SessionState,
  MessageEntry,
  TreeNode,
  CommandItem,
  ModelInfo,
  NeutralMessage,
  SessionStats,
  TokenUsage,
  ContextUsage,
} from "../domain/events/session-state";

/** Model → ModelInfo。 */
export function toModelInfo(pi: Model): ModelInfo {
  return {
    provider: pi.provider,
    id: pi.id,
    name: pi.name,
    reasoning: pi.reasoning,
    contextWindow: pi.contextWindow,
    maxTokens: pi.maxTokens,
    input: pi.input,
  };
}

/** RpcSessionState → SessionState。 */
export function toSessionState(pi: RpcSessionState): SessionState {
  return {
    model: pi.model ? toModelInfo(pi.model) : undefined,
    thinkingLevel: pi.thinkingLevel,
    isStreaming: pi.isStreaming,
    isCompacting: pi.isCompacting,
    steeringMode: pi.steeringMode,
    followUpMode: pi.followUpMode,
    sessionFile: pi.sessionFile,
    sessionId: pi.sessionId,
    sessionName: pi.sessionName,
    autoCompactionEnabled: pi.autoCompactionEnabled,
    messageCount: pi.messageCount,
    pendingMessageCount: pi.pendingMessageCount,
  };
}

/** SessionEntry → MessageEntry。 */
export function toMessageEntry(pi: SessionEntry): MessageEntry {
  return {
    id: pi.id,
    type: pi.type,
    content: pi.content,
    toolCalls: pi.toolCalls,
    toolCallId: pi.toolCallId,
    timestamp: pi.timestamp,
  };
}

/** SessionTreeNode → TreeNode(递归;pi 节点是 {entry,children,label},取 entry.id 作锚)。 */
export function toTreeNode(pi: SessionTreeNode): TreeNode {
  return {
    entryId: pi.entry?.id ?? "",
    children: pi.children?.map(toTreeNode),
    isLeaf: (pi.children ?? []).length === 0,
    label: pi.label,
  };
}

/** RpcSlashCommand → CommandItem。 */
export function toCommandItem(pi: RpcSlashCommand): CommandItem {
  return {
    name: pi.name,
    description: pi.description,
    source: pi.source,
  };
}

/** 底座 AgentMessage → NeutralMessage(role/content 本就中性,宽松透传)。 */
export function toNeutralMessage(pi: { role?: string; content?: unknown; timestamp?: number }): NeutralMessage {
  return { ...pi, role: pi.role ?? "unknown" } as NeutralMessage;
}

/** get_session_stats 响应 → 圆心 SessionStats(防御性提取,字段缺失回退 0/null)。
 *  tps 由调用方(session-store)从事件流自算后注入,底座不给。 */
export function toSessionStats(data: unknown, tps: number | null): SessionStats {
  const d = (data ?? {}) as Record<string, unknown>;
  const num = (k: string): number => (typeof d[k] === "number" ? (d[k] as number) : 0);
  const tok = (d.tokens ?? {}) as Record<string, unknown>;
  const tnum = (k: string): number => (typeof tok[k] === "number" ? (tok[k] as number) : 0);
  const tokens: TokenUsage = {
    input: tnum("input"), output: tnum("output"),
    cacheRead: tnum("cacheRead"), cacheWrite: tnum("cacheWrite"), total: tnum("total"),
  };
  const cu = d.contextUsage as Record<string, unknown> | undefined;
  const contextUsage: ContextUsage | undefined = cu ? {
    tokens: typeof cu.tokens === "number" ? cu.tokens : null,
    contextWindow: typeof cu.contextWindow === "number" ? cu.contextWindow : 0,
    percent: typeof cu.percent === "number" ? cu.percent : null,
  } : undefined;
  return {
    userMessages: num("userMessages"),
    assistantMessages: num("assistantMessages"),
    toolCalls: num("toolCalls"),
    toolResults: num("toolResults"),
    totalMessages: num("totalMessages"),
    tokens,
    cost: typeof d.cost === "number" ? d.cost : 0,
    contextUsage,
    tps,
  };
}
