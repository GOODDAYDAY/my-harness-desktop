// dsh 事件翻译单测:验证 dsh SessionEventMap → 中性 SessionEvent 的第一刀映射。
import { describe, it, expect } from "vitest";
import { translateDshEvent } from "./dsh-event-translator";

describe("translateDshEvent", () => {
  it("turn/start、turn/end → agentStart/agentSettled(回合边界)", () => {
    expect(translateDshEvent({ type: "turn/start", turn: 1 })).toEqual({ type: "agentStart" });
    expect(translateDshEvent({ type: "turn/end", turn: 1, reason: { kind: "completed" } })).toEqual({ type: "agentSettled", reason: "completed" });
    // 缺 reason 的 turn/end(旧形状)不带 reason 字段,不抛错
    expect(translateDshEvent({ type: "turn/end", turn: 1 })).toEqual({ type: "agentSettled" });
  });

  it("step/start、step/end → stepStart/stepEnd(单次模型调用边界)", () => {
    expect(translateDshEvent({ type: "step/start", turn: 1, step: 1 })).toEqual({ type: "stepStart" });
    expect(translateDshEvent({ type: "step/end", turn: 1, step: 1 })).toEqual({ type: "stepEnd" });
  });

  it("user/message → messageEnd(role user + content + id)", () => {
    const r = translateDshEvent({ type: "user/message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] });
    expect(r).toEqual({ type: "messageEnd", message: { role: "user", content: [{ type: "text", text: "hi" }], id: "u1" } });
  });

  it("assistant/message → messageEnd(role assistant)", () => {
    const r = translateDshEvent({
      type: "assistant/message",
      turn: 1,
      step: 1,
      message: { id: "a1", role: "assistant", content: [{ type: "text", text: "answer" }] },
    });
    expect(r).toEqual({ type: "messageEnd", message: { role: "assistant", content: [{ type: "text", text: "answer" }], id: "a1" } });
  });

  it("assistant/message 的 usage 映射为中性 usage 形状(inputTokens→input、cacheReadTokens→cacheRead、totalTokens=四项和)", () => {
    const r = translateDshEvent({
      type: "assistant/message",
      message: { id: "a1", role: "assistant", content: [], usage: { inputTokens: 10, outputTokens: 60, cacheReadTokens: 3, cacheWriteTokens: 2 } },
    });
    expect(r).toMatchObject({
      type: "messageEnd",
      message: { usage: { input: 10, output: 60, cacheRead: 3, cacheWrite: 2, cost: 0, totalTokens: 75 } },
    });
  });

  it("assistant/message 无 usage 时不带 usage 字段(不伪造零值)", () => {
    const r = translateDshEvent({ type: "assistant/message", message: { id: "a1", role: "assistant", content: [] } });
    expect(r).toMatchObject({ type: "messageEnd", message: { id: "a1" } });
    expect((r as { message: Record<string, unknown> }).message.usage).toBeUndefined();
  });

  it("tool/call → toolCallStart(arguments JSON 字符串解析成 args 对象)", () => {
    const r = translateDshEvent({ type: "tool/call", turn: 1, step: 1, callId: "c1", name: "bash", arguments: '{"command":"ls"}' });
    expect(r).toEqual({ type: "toolCallStart", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
  });

  it("tool/call arguments 解析失败时原样返回字符串", () => {
    const r = translateDshEvent({ type: "tool/call", callId: "c2", name: "bash", arguments: "not-json" });
    expect(r).toMatchObject({ type: "toolCallStart", args: "not-json" });
  });

  it("tool/result → toolCallEnd(result + isError)", () => {
    const r = translateDshEvent({
      type: "tool/result",
      turn: 1,
      step: 1,
      message: { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "out" }], isError: false }] },
    });
    expect(r).toEqual({ type: "toolCallEnd", toolCallId: "c1", result: [{ type: "text", text: "out" }], isError: false });
  });

  it("tool/result 带 error 时 isError=true", () => {
    const r = translateDshEvent({
      type: "tool/result",
      message: { content: [{ type: "tool-result", toolCallId: "c1", content: [] }] },
      error: { name: "E", code: "1" },
    });
    expect(r).toMatchObject({ type: "toolCallEnd", isError: true });
  });

  it("assistant/message 的 content 块类型归一:tool-call→toolCall(补 args)、tool-result→toolResult", () => {
    const r = translateDshEvent({
      type: "assistant/message",
      message: {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' },
          { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "out" }] },
        ],
      },
    });
    expect(r).toEqual({
      type: "messageEnd",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "toolCall", id: "c1", name: "bash", arguments: '{"command":"ls"}', args: { command: "ls" } },
          { type: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "out" }] },
        ],
        id: "a1",
      },
    });
  });

  it("assistant/message 的 reasoning 块归一为 thinking(不归一会话流丢整段思考链)", () => {
    const r = translateDshEvent({
      type: "assistant/message",
      data: { message: { id: "a1", role: "assistant", content: [{ type: "reasoning", text: "先想一下" }] } },
    });
    expect(r).toEqual({
      type: "messageEnd",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "先想一下" }], id: "a1" },
    });
  });

  it("真实外壳下 usage 在 data.usage(与 message 平级),不在 data.message 里", () => {
    const r = translateDshEvent({
      type: "assistant/message", seq: 46, time: 1,
      data: {
        turn: 1, step: 1,
        message: { id: "a1", role: "assistant", content: [] },
        usage: { inputTokens: 10, outputTokens: 60, cacheReadTokens: 3, cacheWriteTokens: 2 },
      },
    });
    expect(r).toMatchObject({
      type: "messageEnd",
      message: { usage: { input: 10, output: 60, cacheRead: 3, cacheWrite: 2, cost: 0, totalTokens: 75 } },
    });
  });

  it("todo/write、assistant/chunk(非 finish)、session/end-seed 等中性域无对应 → null", () => {
    expect(translateDshEvent({ type: "todo/write", todos: [] })).toBeNull();
    expect(translateDshEvent({ type: "assistant/chunk", turn: 1, step: 1, chunk: {} })).toBeNull();
    expect(translateDshEvent({ type: "session/end-seed" })).toBeNull();
  });

  it("真实外壳形状:payload 在 data 字段下(user/message、assistant/message)", () => {
    const u = translateDshEvent({
      type: "user/message", seq: 4, time: 1,
      data: { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
      surfaceOp: "append",
    });
    expect(u).toEqual({ type: "messageEnd", message: { role: "user", content: [{ type: "text", text: "hi" }], id: "u1" } });

    const a = translateDshEvent({
      type: "assistant/message", seq: 46, time: 1,
      data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", content: [{ type: "text", text: "answer" }] }, usage: {} },
      sourceEventSeqs: [45], surfaceOp: "append",
    });
    expect(a).toEqual({ type: "messageEnd", message: { role: "assistant", content: [{ type: "text", text: "answer" }], id: "a1" } });
  });

  it("assistant/chunk 的 finish-error → messageEnd 带 error(不吞失败原因)", () => {
    const r = translateDshEvent({
      type: "assistant/chunk", seq: 5, time: 1,
      data: { turn: 1, step: 1, chunk: { type: "finish", reason: { kind: "error", failure: { message: "llm-pi-ai: no credential ... US_NEW_API_KEY", code: "MISSING_CREDENTIAL" } } } },
    });
    expect(r).toMatchObject({ type: "messageEnd", message: { role: "assistant", error: true } });
    expect((r as { message?: { errorMessage?: string } }).message?.errorMessage).toContain("US_NEW_API_KEY");
  });
});
