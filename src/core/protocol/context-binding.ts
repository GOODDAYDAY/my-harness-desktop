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
} from "./rpc-types";
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
import { entryTimestampMs } from "../domain/events/session-state";

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
    timestamp: entryTimestampMs(pi.timestamp),
  };
}

/** SessionTreeNode → TreeNode(递归;pi 节点是 {entry,children,label},取 entry.id 作锚)。
 *  enrichment:从 entry 提取 entryType/preview/timestamp——展示层直接读,不再 join。 */
export function toTreeNode(pi: SessionTreeNode): TreeNode {
  const { entryType, preview } = extractTreePreview(pi.entry);
  return {
    entryId: pi.entry?.id ?? "",
    children: pi.children?.map(toTreeNode),
    isLeaf: (pi.children ?? []).length === 0,
    label: pi.label,
    entryType,
    preview,
    timestamp: entryTimestampMs(pi.entry?.timestamp),
  };
}

/** 从底座 entry 提取展示层用的 type/preview(纯函数,缺 entry 时回退 unknown)。 */
function extractTreePreview(entry?: SessionEntry): { entryType: string; preview: string } {
  if (!entry) return { entryType: "unknown", preview: "" };
  const type = entry.type ?? "unknown";
  /** 文本可能是纯 string 或内容块数组([{type:"text",text}]);取首个非空文本片段首行。 */
  const firstLine = (s?: unknown): string => {
    const raw = typeof s === "string" ? s : Array.isArray(s)
      ? (s.find((b) => b?.type === "text" && typeof b?.text === "string")?.text as string | undefined)
      : undefined;
    return typeof raw === "string" ? (raw.split("\n").find((l) => l.trim()) ?? "").slice(0, 120) : "";
  };
  const content = entry.content as Record<string, unknown> | undefined;
  switch (type) {
    case "message": {
      const role = (content?.role ?? "unknown") as string;
      if (role === "user") return { entryType: "user", preview: firstLine(content?.content) };
      if (role === "assistant") return { entryType: "assistant", preview: firstLine(content?.content) };
      if (role === "toolResult") {
        const name = (content?.name ?? content?.toolName ?? "tool") as string;
        return { entryType: "toolResult", preview: `${name}: ${firstLine(content?.output ?? content?.content)}` };
      }
      if (role === "bashExecution") return { entryType: "bashExecution", preview: firstLine(content?.command ?? content?.content) };
      if (role === "custom") return { entryType: "custom", preview: firstLine(content?.content) };
      if (role === "branchSummary") return { entryType: "branchSummary", preview: firstLine(content?.summary) };
      if (role === "compactionSummary") return { entryType: "compactionSummary", preview: firstLine(content?.summary) };
      return { entryType: role, preview: firstLine(content?.content) };
    }
    case "model_change": return { entryType: "model_change", preview: `${content?.provider ?? ""} · ${content?.modelId ?? ""}` };
    case "thinking_level_change": return { entryType: "thinking_level_change", preview: `${content?.thinkingLevel ?? ""}` };
    case "compaction": return { entryType: "compaction", preview: firstLine(content?.summary) };
    case "branch_summary": return { entryType: "branch_summary", preview: firstLine(content?.summary) };
    case "label": return { entryType: "label", preview: firstLine(content?.label) };
    case "custom": return { entryType: "custom", preview: firstLine(content?.content) };
    case "custom_message": return { entryType: "custom_message", preview: firstLine(content?.content) };
    case "label_reset": return { entryType: "label_reset", preview: firstLine(content?.label) };
    case "session_info": return { entryType: "session_info", preview: firstLine(content?.name) };
    default: return { entryType: type, preview: firstLine(content?.content) };
  }
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
