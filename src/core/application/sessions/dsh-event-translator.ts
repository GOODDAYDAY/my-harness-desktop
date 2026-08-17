// dsh 事件 → 中性事件翻译(§4.3 映射表的第一刀)。
//
// 依据 docs/design/base-interface-lineage.md §4.3:dsh 的 SessionEventMap(type 键是
// turn/start、user/message、assistant/message、tool/call、tool/result 等)投成中性
// SessionEvent(type:turnStart、messageStart/End、toolCallStart/End 等)。
//
// 第一刀只映射「完整消息」事件:user/message 与 assistant/message → messageEnd
// (renderer 的 messageEnd 支持 find-by-id patch + 找不到追加,完整消息直接落)。assistant/chunk
// 的 token 级流式(chunk 组装成 messageUpdate)留待后续——那需要按 StreamChunk 增量拼 content 块。
// step/start、step/end、todo/write、request/header、request/context、session/end-seed 中性域无对应,丢弃。
import type { SessionEvent } from "../../domain/events/session-state";

/** dsh 事件 → 中性事件;无对应返回 null(调用方丢弃)。 */
export function translateDshEvent(event: unknown): SessionEvent | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  switch (e.type) {
    case "turn/start":
      return { type: "turnStart" };
    case "turn/end":
      return { type: "turnEnd" };

    // user/message:事件数据即 UserMessage 本身(id/role/content 在顶层)。
    case "user/message": {
      const id = typeof e.id === "string" ? e.id : undefined;
      return { type: "messageEnd", message: { role: "user", content: e.content, id } };
    }

    // assistant/message:AssistantMessage 包在 message 字段里。
    case "assistant/message": {
      const m = (e.message ?? {}) as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : undefined;
      return { type: "messageEnd", message: { role: "assistant", content: m.content, id } };
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
