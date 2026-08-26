// 内核类型 → 圆心中性类型映射 —— gateway。
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
} from "@my-harness-desktop/shared";
import { entryTimestampMs } from "@my-harness-desktop/shared";

/** Model → ModelInfo。本映射只服务 pi 后端,故 kernel 写死 "pi";dsh 的模型
 *  走 model-catalog 的 dsh reader(§3.3),不经过这里。 */
export function toModelInfo(pi: Model): ModelInfo {
  return {
    kernel: "pi",
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

/** 从内核 entry 提取展示层用的 type/preview(纯函数,缺 entry 时回退 unknown)。
 *  线格式以内核 session-manager.d.ts 为准:载荷在顶层(message/provider/summary/…),
 *  不包在 content 里——此前按 content.{role,summary} 读全部落空,消息节点整片渲染
 *  空白/entryId,根因即字段形状不匹配。 */
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
  switch (type) {
    case "message": {
      const msg = entry.message;
      const role = msg?.role ?? "unknown";
      if (role === "user") return { entryType: "user", preview: firstLine(msg?.content) };
      if (role === "assistant") {
        const text = firstLine(msg?.content);
        if (text) return { entryType: "assistant", preview: text };
        // 纯思考+工具调用轮(无 text 块):取工具调用名兜底,否则树/列表渲染空白行
        const blocks = Array.isArray(msg?.content) ? msg.content : [];
        const tools = blocks
          .filter((b): b is { type: string; name?: string } => Boolean(b) && (b as { type?: string }).type === "toolCall")
          .map((b) => b.name ?? "tool");
        return { entryType: "assistant", preview: tools.length ? `⚡ ${tools.join(" · ")}` : "" };
      }
      if (role === "toolResult") {
        return { entryType: "toolResult", preview: `${msg?.toolName ?? "tool"}: ${firstLine(msg?.content)}` };
      }
      return { entryType: role, preview: firstLine(msg?.content) };
    }
    case "model_change": return { entryType: "model_change", preview: `${entry.provider ?? ""} · ${entry.modelId ?? ""}` };
    case "thinking_level_change": return { entryType: "thinking_level_change", preview: `${entry.thinkingLevel ?? ""}` };
    case "compaction": return { entryType: "compaction", preview: firstLine(entry.summary) };
    case "branch_summary": return { entryType: "branch_summary", preview: firstLine(entry.summary) };
    case "label": return { entryType: "label", preview: firstLine(entry.label) };
    case "label_reset": return { entryType: "label_reset", preview: firstLine(entry.label) };
    case "session_info": return { entryType: "session_info", preview: firstLine(entry.name) };
    case "custom": return { entryType: "custom", preview: firstLine(entry.customType) };
    case "custom_message": return { entryType: "custom_message", preview: firstLine(entry.content) };
    default: return { entryType: type, preview: firstLine(entry.content) };
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

/** 内核 AgentMessage → NeutralMessage(role/content 本就中性,宽松透传)。 */
export function toNeutralMessage(pi: { role?: string; content?: unknown; timestamp?: number }): NeutralMessage {
  return { ...pi, role: pi.role ?? "unknown" } as NeutralMessage;
}

/** get_session_stats 响应 → 圆心 SessionStats(防御性提取,字段缺失回退 0/null)。
 *  local 是桌面端从事件流自算的统计(内核不给),由调用方(session-store)注入。 */
export function toSessionStats(data: unknown, local: Pick<SessionStats, "tps" | "turn" | "lastTurn" | "turns" | "steps">): SessionStats {
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
    ...local,
  };
}
