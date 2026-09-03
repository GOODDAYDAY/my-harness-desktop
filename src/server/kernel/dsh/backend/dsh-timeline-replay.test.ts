// dsh 多步回合(思考+工具调用+作答)的全链证明:内核事件流 → 中性事件 → 渲染层消息
// → 块分解,最终 thinking / toolCall / text 三类块一个不少(用户报告「工具调用、思考
// 都不展示」的反向钉——链路在哪一环断,这个测试就在哪一环红)。
//
// 事件序列照抄真实 dsh 日志的形状(reasoning-chunks 批式 + tool/call + tool/result +
// assistant/message 终态),不依赖真实模型。
import { describe, it, expect } from "vitest";
import { createDshEventTranslator } from "./dsh-event-translator";
import { applyEvent } from "../../../../web/stores/session-store";
import { decomposeMessage } from "../../../../plugins/sessions/timeline/renderer/blocks";
import type { NeutralMessage } from "@my-harness-desktop/shared";

describe("dsh 多步回合全链:思考+工具调用+作答都进渲染面(问题13守卫)", () => {
  it("思考链 + 工具卡 + 文本块在终态消息里齐备", () => {
    const t = createDshEventTranslator({ provider: "us-new", model: "m" });
    // 真实 dsh 日志形状的回合:reasoning-chunks → tool/call → tool/result → assistant/message
    const events: unknown[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "step/start", data: { turn: 1, step: 1 } },
      { type: "user/message", data: { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "读一下 a.ts" }] } },
      { type: "reasoning-chunks", time0: 1, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["先想一下"] } },
      { type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"path":"a.ts"}' } },
      { type: "tool/result", data: { turn: 1, step: 1, message: { content: [{ type: "tool-result", toolCallId: "c1", content: "文件内容" }] } } },
      { type: "assistant/message", data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", content: [
        { type: "reasoning", text: "先想一下" },
        { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.ts"}' },
        { type: "text", text: "读完了" },
      ] } } },
      { type: "step/end", data: { turn: 1, step: 1 } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];

    // 渲染侧消息流模拟:发送即乐观 user + pending 占位(与 sendMessage 同形状)
    let messages: NeutralMessage[] = [
      { id: "u-opt", role: "user", content: "读一下 a.ts", __sendText: "读一下 a.ts", __optimistic: true } as unknown as NeutralMessage,
      { id: "a-pend", role: "assistant", content: "", pending: true } as unknown as NeutralMessage,
    ];
    for (const e of events) {
      for (const ne of t(e)) messages = applyEvent(messages, ne as never);
    }

    // 无 pending 残留(问题2 不复发)
    expect(messages.filter((m) => m.pending === true)).toHaveLength(0);

    // 找到 assistant 终态消息
    const asst = messages.filter((m) => m.role === "assistant");
    expect(asst.length).toBeGreaterThan(0);
    const last = asst[asst.length - 1];

    // 块分解:thinking + toolCall + text 三类都在
    const blocks = decomposeMessage(last, [], new Set());
    const kinds = (blocks ?? []).map((b) => b.type);
    expect(kinds).toContain("thinking"); // 思考链展示
    expect(kinds).toContain("toolCall"); // 工具卡展示
    expect(kinds).toContain("text"); // 作答文本展示
  });
});
