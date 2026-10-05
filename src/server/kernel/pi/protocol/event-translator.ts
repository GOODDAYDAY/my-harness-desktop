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
  // compaction_end:两件事要在这一层做完,都是「内核线格式的知识」,不许漏进消费方。
  //
  // (1) 摘要归一。pi 把摘要嵌在 `result` 下(agent-session.ts 的 CompactionResult:
  //   { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, details }),
  //   而圆心契约 CompactionEndEvent 声明的是**顶层** summary/tokensBefore。
  //   不归一的后果是双层的、且都是静默的:① 壳的写穿读不到 summary → 压缩分隔线没有 detail
  //     → seed 投影的「摘要代身」永远走不到,一律保守全量回灌(压缩白做);
  //     ② 读不到 tokensBefore → UI 只显示「上下文已压缩」,没有 token 数。
  //   实测锚点:scripts/demo/compaction-rewind.e2e.mjs「分隔线带摘要 detail / 带 tokens」两条断言。
  //
  // (2) 成败判定。pi 在**取消与失败**时同样发 compaction_end,只是 `result: undefined`
  //   (扩展 cancel / signal aborted → aborted:true;生成摘要的那次模型调用抛错 → 带 errorMessage;
  //   溢出恢复第二次仍失败 → 同样只带 errorMessage)。所以 `result != null` 是 pi 唯一可靠的
  //   「真的压了」信号,翻译成契约的 compacted 三态(true/false/缺省,语义见圆心注释)。
  //   不归一的后果更严重:壳无条件落分隔线 → **假边界**。实测(真实 502 撞上摘要调用):
  //   中间层出现 divider compaction,而底层内核的 compaction 条目数为 0 —— 内核没压缩,
  //   壳却记了边界。假边界会遮蔽更早的真摘要(assembleSeedProjection 找到最新边界就 break)
  //   并让 UI 谎报「上下文已压缩」,用户以为上下文变小了、实际仍是满的 → 继续发 → 真溢出。
  //   实测锚点:scripts/demo/compaction-overflow-rewind.e2e.mjs 的 Phase C。
  //
  // 归一放在这一层而不是消费方:内核线格式的知识只许住在协议翻译层(§1.1 依赖只向内);
  // 且 pi/dsh 的形状差异是**行为级**的(dsh 的成败在 end 的 error 字段上),不塞进共享路径(§3.3)。
  if (neutralType === "compactionEnd") {
    const raw = piEvent as { result?: unknown; aborted?: unknown; errorMessage?: unknown };
    const result = raw.result;
    const r = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary : undefined;
    const tokensBefore = typeof r.tokensBefore === "number" && Number.isFinite(r.tokensBefore) ? r.tokensBefore : undefined;
    const aborted = raw.aborted === true ? true : undefined;
    const errorMessage = typeof raw.errorMessage === "string" && raw.errorMessage.trim() ? raw.errorMessage : undefined;
    return {
      ...piEvent, type: neutralType,
      // pi 的成败真相:有 result **对象**才是真的压了(数组也是 object 但不是 CompactionResult,排除)。
      compacted: result != null && typeof result === "object" && !Array.isArray(result),
      // ⚠ 这四个字段**显式赋值覆盖**,不用「有值才加」的条件展开:pi 原事件常带
      //   `aborted: false` / `errorMessage: ""` 这类空值,靠 `...piEvent` 透传会把它们漏进契约字段
      //   (实测:errorMessage:"" 漏出 → UI 弹一条空 toast)。归一层对它管的字段负全责,
      //   无效值一律归成 undefined(键在、值为 undefined),消费方 `?? ""` 与 `!== undefined` 判据都成立。
      //   (pi 私有的 result/willRetry 仍随 ...piEvent 透传,但契约没声明、无消费方读,无害。)
      aborted,
      errorMessage,
      summary,
      tokensBefore,
    } as SessionEvent;
  }
  // 翻译后的事件:type 用中性名,其余字段原样保留
  return { ...piEvent, type: neutralType } as SessionEvent;
}
