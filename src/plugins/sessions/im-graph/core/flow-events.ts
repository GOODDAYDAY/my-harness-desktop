// im-graph/core/flow-events —— 事件流面板的条目模型与增量聚合(纯 TS,可裸单测)。
// 聚焦会话的 stream 事件 → 面板条目:边界事件原样标记,消息按 messageId 归并
// 流式递增,工具调用按 toolCallId 归并(start 一行,end 同行补 ✓/✗)——
// 碎事件(toolCallUpdate/turn* /usage 等)不进面板,防刷屏。
import { messageContentText, type SessionEvent } from "@pi-desktop/contract";

export type FlowKind = "message" | "tool" | "boundary";

export interface FlowEvent {
  id: string;
  ts: number;
  kind: FlowKind;
  text: string;
  /** messageUpdate 流式中(渲染层挂流式光标);messageEnd 落定。 */
  streaming?: boolean;
  /** messageUpdate/End 的归并键:同一条消息的更新合到同一行。 */
  messageId?: string;
  /** toolCallEnd 的归并键:end 找到 start 那行补 ✓/✗。 */
  toolCallId?: string;
}

const TEXT_LIMIT = 200;
const LIST_LIMIT = 200;

const BOUNDARY_TYPES = new Set([
  "sessionStart", "agentStart", "agentEnd", "agentSettled",
  "compactionStart", "compactionEnd", "turnStart", "turnEnd",
]);

export function appendFlowEvent(
  list: FlowEvent[],
  eventType: string,
  raw: unknown,
  ts: number,
  seq: number,
): FlowEvent[] {
  const event = raw as SessionEvent | undefined;
  const msg = (event as { message?: { id?: string; role?: string; content?: unknown } } | undefined)?.message;
  const push = (kind: FlowKind, text: string, extra?: Partial<FlowEvent>): FlowEvent[] => [
    ...list.slice(-(LIST_LIMIT - 1)),
    { id: `${ts.toString(36)}-${seq.toString(36)}`, ts, kind, text, ...extra },
  ];

  if (BOUNDARY_TYPES.has(eventType)) return push("boundary", eventType);

  switch (eventType) {
    case "messageStart":
      return push("message", `messageStart · ${msg?.role ?? "?"}`);
    case "messageUpdate": {
      const text = messageContentText(msg?.content).slice(0, TEXT_LIMIT);
      const messageId = msg?.id ?? "";
      const last = list[list.length - 1];
      if (last?.kind === "message" && last.streaming && last.messageId === messageId) {
        return [...list.slice(0, -1), { ...last, text, ts }];
      }
      return push("message", text, { streaming: true, messageId });
    }
    case "messageEnd": {
      const text = messageContentText(msg?.content).slice(0, TEXT_LIMIT) || "messageEnd";
      const messageId = msg?.id ?? "";
      const last = list[list.length - 1];
      if (last?.kind === "message" && last.streaming && last.messageId === messageId) {
        return [...list.slice(0, -1), { ...last, text, ts, streaming: false }];
      }
      return push("message", text);
    }
    case "toolCallStart": {
      const e = event as { toolName?: unknown; toolCallId?: unknown } | undefined;
      const name = typeof e?.toolName === "string" ? e.toolName : "?";
      const toolCallId = typeof e?.toolCallId === "string" ? e.toolCallId : "";
      return push("tool", name, { toolCallId });
    }
    case "toolCallEnd": {
      const e = event as { toolCallId?: unknown; isError?: unknown } | undefined;
      const toolCallId = typeof e?.toolCallId === "string" ? e.toolCallId : "";
      const mark = e?.isError === true ? "✗" : "✓";
      for (let i = list.length - 1; i >= 0; i--) {
        const it = list[i];
        if (it.kind === "tool" && it.toolCallId === toolCallId && !it.text.endsWith("✓") && !it.text.endsWith("✗")) {
          return [...list.slice(0, i), { ...it, text: `${it.text} ${mark}`, ts }, ...list.slice(i + 1)];
        }
      }
      return push("tool", mark);
    }
    default:
      return list;
  }
}
