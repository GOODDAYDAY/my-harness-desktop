// pi 事件 → 圆心中性事件翻译 —— gateway。
//
// 依据 docs/modules/02 §4.4.2 + docs/structure/16 §3.3.2。
// 把 pi 的 AgentSessionEvent(type: "tool_execution_start" 等)翻译成圆心
// SessionEvent(type: "toolCallStart" 等)。敏感字段过滤留后续(需要权限信息)。
import type { AgentSessionEvent } from "./rpc-types";
import type { SessionEvent } from "@my-harness-desktop/shared";
import { withNormalizedToolCalls, withTerminalState } from "@my-harness-desktop/shared";

/** pi 事件 type → 圆心事件 type 的映射表。 */
const TYPE_MAP: Record<string, string> = {
  agent_start: "agentStart",
  agent_end: "agentEnd",
  agent_settled: "agentSettled",
  turn_start: "stepStart",
  turn_end: "stepEnd",
  message_start: "messageStart",
  message_update: "messageUpdate",
  message_end: "messageEnd",
  entry_appended: "entryAppended",
  session_start: "sessionStart",
  session_info_changed: "sessionInfoChanged",
  model_select: "modelSelect",
  thinking_level_changed: "thinkingLevelChanged",
  thinking_level_select: "thinkingLevelSelect",
  tool_execution_start: "toolCallStart",
  tool_execution_update: "toolCallUpdate",
  tool_execution_end: "toolCallEnd",
  compaction_start: "compactionStart",
  compaction_end: "compactionEnd",
  queue_update: "queueUpdate",
  auto_retry_start: "autoRetryStart",
  auto_retry_end: "autoRetryEnd",
};

/**
 * 翻译 pi 事件为圆心中性事件。
 * - type 映射(tool_execution_start → toolCallStart)
 * - 字段名映射(toolCallId 等保持原名,pi 已用 camelCase)
 * - 未识别 type 原样透传(兜底)
 * - 敏感字段过滤(content[]/toolCalls[].args)留后续(需权限信息)
 */
export function translateEvent(piEvent: AgentSessionEvent): SessionEvent {
  const neutralType = TYPE_MAP[piEvent.type] ?? piEvent.type;
  // 消息载体事件:终结态(stopReason error/aborted、errorMessage)归一为 error/stopped 标记,与文件读路径同规则
  const msg = (piEvent as { message?: unknown }).message;
  if (
    msg && typeof msg === "object" &&
    (neutralType === "messageStart" || neutralType === "messageUpdate" || neutralType === "messageEnd")
  ) {
    return { ...piEvent, type: neutralType, message: withNormalizedToolCalls(withTerminalState(msg as Record<string, unknown>)) } as SessionEvent;
  }
  // session_info_changed:内核字段是 name,圆心契约是 sessionName——协议翻译归 gateway,
  // 字段映射在此完成(此前原样透传 name,与 domain 契约 sessionName 漂移:消费方永远读到 undefined)。
  if (neutralType === "sessionInfoChanged") {
    const raw = (piEvent as { name?: unknown }).name;
    const name = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    return { ...piEvent, type: neutralType, sessionName: name } as SessionEvent;
  }
  // compaction_end:pi 把摘要嵌在 `result` 下(agent-session.ts 的 CompactionResult:
  //   { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, details }),
  // 而圆心契约 CompactionEndEvent 声明的是**顶层** summary/tokensBefore。
  // 不归一的后果是双层的、且都是静默的:① 壳的写穿读不到 summary → 压缩分隔线没有 detail
  //   → seed 投影的「摘要代身」永远走不到,一律保守全量回灌(压缩白做);
  //   ② 读不到 tokensBefore → UI 只显示「上下文已压缩」,没有 token 数。
  // 实测锚点:scripts/demo/compaction-rewind.e2e.mjs 的 ⑰⑱(底层内核有 summary、中间层没有)。
  // 归一放在这一层而不是消费方:内核线格式的知识只许住在协议翻译层(§1.1 依赖只向内)。
  if (neutralType === "compactionEnd") {
    const result = (piEvent as { result?: unknown }).result;
    const r = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary : undefined;
    const tokensBefore = typeof r.tokensBefore === "number" && Number.isFinite(r.tokensBefore) ? r.tokensBefore : undefined;
    return {
      ...piEvent, type: neutralType,
      ...(summary !== undefined ? { summary } : {}),
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
    } as SessionEvent;
  }
  // 翻译后的事件:type 用中性名,其余字段原样保留
  return { ...piEvent, type: neutralType } as SessionEvent;
}
