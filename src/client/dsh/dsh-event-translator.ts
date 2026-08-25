// dsh 事件 → 中性事件翻译(§4.3 映射表的第二刀:按语义对齐 pi 的 agent/turn)。
//
// 依据 docs/design/base-interface-lineage.md §4.3 + dsh-session 的 SessionEventMap 实型:
// dsh 的「turn」是粗粒度一整轮执行(≈ pi 的 agent loop),「step」是一次模型调用 + 它请求的
// 工具执行(≈ pi 的 turn)。这里按语义对齐成同一套中性事件:
//   turn/start → agentStart、turn/end → agentSettled、step/start → stepStart、step/end → stepEnd。
// 这样 pi/dsh 吐给壳子的中性事件同一套,切内核透明(notifier 依赖 agentSettled 即内核无关)。
// 注:中性 stepStart/stepEnd(单次模型调用)此前误命名为 turnStart/turnEnd,与"回合"撞名,已纠正。
//
// dsh session 事件的外壳是 { type, seq, time, data, surfaceOp? }——真正的 payload 统一在
// data 字段下(user/message 的 id/content、assistant/message 的 message、tool/call 的
// callId/name/arguments 都在 data 里)。读字段必须从 data 读,不能从外壳顶层读。
//
// 仍未接:assistant/chunk 的 token 级流式(chunk 组装成 messageStart/messageUpdate 需跨事件
// 维护状态,非纯函数能干净做,留后续);但 chunk 的 finish-error 块是模型请求失败的信号,已接:
// 翻译成带 error 的 messageEnd,避免错误被吞、测试只见 "no response"。
// todo/write、request/header、request/context、session/end-seed 等中性域无对应的 log-only 事件,丢弃。
import type { SessionEvent } from "../../core/domain/events/session-state";

/** dsh 事件 → 中性事件;无对应返回 null(调用方丢弃)。 */
export function translateDshEvent(event: unknown): SessionEvent | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  // payload 在 data 字段下;对无 data 的平铺形状(单测旧形状)回落 e 自身,兼容两者。
  const d = (e.data ?? e) as Record<string, unknown>;
  switch (e.type) {
    // 回合边界:dsh 的 turn ≈ pi 的 agent loop,故映射 agentStart/agentSettled(非 turnStart/turnEnd)。
    case "turn/start":
      return { type: "agentStart" };
    case "turn/end": {
      // 把 turn/end reason 带进中性流(不再丢弃):「继续执行」入口据此判断是否异常停机。
      const reason = (d.reason ?? {}) as Record<string, unknown>;
      return { type: "agentSettled", ...(typeof reason.kind === "string" ? { reason: reason.kind } : {}) };
    }

    // 单次模型调用边界:dsh 的 step = one model call + 其工具执行 ≈ pi 的 turn。
    case "step/start":
      return { type: "stepStart" };
    case "step/end":
      return { type: "stepEnd" };

    // user/message:payload 即 UserMessage 本身(id/role/content 在 data 顶层)。
    case "user/message": {
      const id = typeof d.id === "string" ? d.id : undefined;
      return { type: "messageEnd", message: { role: "user", content: normalizeContent(d.content), id } };
    }

    // assistant/message:AssistantMessage 包在 data.message 字段里;usage 一并映射,
    // 否则壳的 turn/tps 累计(靠 messageEnd.usage)对 dsh 恒 0。
    // usage 在 data.usage(与 message 平级),不在 data.message 里——读 message.usage 恒丢(根因)。
    case "assistant/message": {
      const m = (d.message ?? {}) as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : undefined;
      const usage = mapDshUsage(d.usage ?? m.usage);
      return { type: "messageEnd", message: { role: "assistant", content: normalizeContent(m.content), id, ...(usage ? { usage } : {}) } };
    }

    // assistant/chunk:token 级流式不接;只接 finish-error(模型请求失败的信号),
    // 翻译成带 error 的 messageEnd,把真实失败原因(如 MISSING_CREDENTIAL)带出去。
    case "assistant/chunk": {
      const chunk = (d.chunk ?? {}) as Record<string, unknown>;
      if (chunk.type !== "finish") return null;
      const reason = (chunk.reason ?? {}) as Record<string, unknown>;
      if (reason.kind !== "error") return null;
      const failure = (reason.failure ?? {}) as Record<string, unknown>;
      const message = typeof failure.message === "string" && failure.message
        ? failure.message
        : "model request failed";
      return { type: "messageEnd", message: { role: "assistant", error: true, errorMessage: message, content: [] } };
    }

    // tool/call:callId/name/arguments(arguments 是模型产出的 JSON 字符串,解析成 args 对象)。
    case "tool/call": {
      return {
        type: "toolCallStart",
        toolCallId: String(d.callId ?? ""),
        toolName: String(d.name ?? "tool"),
        args: parseArgs(d.arguments),
      };
    }

    // tool/result:data.message.content[0] 是 ToolResultBlock(toolCallId/content/isError)。
    case "tool/result": {
      const m = (d.message ?? {}) as { content?: unknown[] };
      const block = (m.content?.[0] ?? {}) as Record<string, unknown>;
      return {
        type: "toolCallEnd",
        toolCallId: String(block.toolCallId ?? ""),
        result: block.content,
        isError: block.isError === true || d.error != null,
      };
    }

    default:
      return null;
  }
}

/** toolCall.arguments 是模型产出的 JSON 字符串,解析成对象;解析失败原样返回字符串(不吞参数)。 */
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** dsh TokenUsage(inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens)→ 中性 usage 形状
 *  (input/output/cacheRead/cacheWrite/cost/totalTokens,messageUsageOf 契约单源读取)。
 *  dsh 无 cost 口径,置 0;totalTokens = 四项和。无/非法 usage 返回 undefined(调用方不带该字段)。 */
function mapDshUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  // 没有任何 token 字段视为无 usage(不伪造全零值;data.usage 常为 {} 占位)。
  if (u.inputTokens == null && u.outputTokens == null && u.cacheReadTokens == null && u.cacheWriteTokens == null) {
    return undefined;
  }
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = n(u.inputTokens);
  const output = n(u.outputTokens);
  const cacheRead = n(u.cacheReadTokens);
  const cacheWrite = n(u.cacheWriteTokens);
  return { input, output, cacheRead, cacheWrite, cost: 0, totalTokens: input + output + cacheRead + cacheWrite };
}

/** dsh ContentBlock 块类型 → pi 中性块类型:tool-call→toolCall(补 args 别名)、tool-result→toolResult。
 *  文本/思考块两侧同名,原样透传;未知块不动(中性域兜底渲染原始 JSON)。 */
function normalizeContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "tool-call":
        return { ...b, type: "toolCall", args: parseArgs(b.arguments) };
      case "tool-result":
        return { ...b, type: "toolResult" };
      // dsh 思考块叫 reasoning,中性域叫 thinking——不归一则 thinkingBlocksOf 过滤
      // type==="thinking" 落空,整段思考链在会话流里静默消失(根因)。
      case "reasoning":
        return { type: "thinking", thinking: typeof b.text === "string" ? b.text : String(b.text ?? "") };
      default:
        return block;
    }
  });
}
