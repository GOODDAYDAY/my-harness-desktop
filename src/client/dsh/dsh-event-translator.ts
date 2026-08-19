// dsh 事件 → 中性事件翻译(§4.3 映射表的第二刀:按语义对齐 pi 的 agent/turn)。
//
// 依据 docs/design/base-interface-lineage.md §4.3 + dsh-session 的 SessionEventMap 实型:
// dsh 的「turn」是粗粒度一整轮执行(≈ pi 的 agent loop),「step」是一次模型调用 + 它请求的
// 工具执行(≈ pi 的 turn)。第一刀按名字错位映射(turn/end → turnEnd),这把 pi/dsh 的
// 「回合收敛」信号劈成了两个名字,壳子被迫感知内核差异。这里改按语义:
//   turn/start → agentStart、turn/end → agentSettled、step/start → turnStart、step/end → turnEnd。
// 这样 pi/dsh 吐给壳子的中性事件同一套,切内核透明(notifier 依赖 agentSettled 即内核无关)。
//
// 仍未接:assistant/chunk 的 token 级流式(chunk 组装成 messageStart/messageUpdate 需跨事件
// 维护状态,非纯函数能干净做,留后续);todo/write、request/header、request/context、
// session/end-seed 等中性域无对应的 log-only 事件,丢弃。
import type { SessionEvent } from "../../core/domain/events/session-state";

/** dsh 事件 → 中性事件;无对应返回 null(调用方丢弃)。 */
export function translateDshEvent(event: unknown): SessionEvent | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  switch (e.type) {
    // 回合边界:dsh 的 turn ≈ pi 的 agent loop,故映射 agentStart/agentSettled(非 turnStart/turnEnd)。
    case "turn/start":
      return { type: "agentStart" };
    case "turn/end":
      return { type: "agentSettled" };

    // 单次模型调用边界:dsh 的 step = one model call + 其工具执行 ≈ pi 的 turn。
    case "step/start":
      return { type: "turnStart" };
    case "step/end":
      return { type: "turnEnd" };

    // user/message:事件数据即 UserMessage 本身(id/role/content 在顶层)。
    case "user/message": {
      const id = typeof e.id === "string" ? e.id : undefined;
      return { type: "messageEnd", message: { role: "user", content: normalizeContent(e.content), id } };
    }

    // assistant/message:AssistantMessage 包在 message 字段里。
    case "assistant/message": {
      const m = (e.message ?? {}) as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : undefined;
      return { type: "messageEnd", message: { role: "assistant", content: normalizeContent(m.content), id } };
    }

    // tool/call:callId/name/arguments(arguments 是模型产出的 JSON 字符串,解析成 args 对象)。
    case "tool/call": {
      return {
        type: "toolCallStart",
        toolCallId: String(e.callId ?? ""),
        toolName: String(e.name ?? "tool"),
        args: parseArgs(e.arguments),
      };
    }

    // tool/result:message.content[0] 是 ToolResultBlock(toolCallId/content/isError)。
    case "tool/result": {
      const m = (e.message ?? {}) as { content?: unknown[] };
      const block = (m.content?.[0] ?? {}) as Record<string, unknown>;
      return {
        type: "toolCallEnd",
        toolCallId: String(block.toolCallId ?? ""),
        result: block.content,
        isError: block.isError === true || e.error != null,
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
      default:
        return block;
    }
  });
}
