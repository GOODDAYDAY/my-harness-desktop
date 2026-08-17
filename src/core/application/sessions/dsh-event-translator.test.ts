// dsh 事件翻译单测:验证 dsh SessionEventMap → 中性 SessionEvent 的第一刀映射。
import { describe, it, expect } from "vitest";
import { translateDshEvent } from "./dsh-event-translator";

describe("translateDshEvent", () => {
  it("turn/start、turn/end 一一对应", () => {
    expect(translateDshEvent({ type: "turn/start", turn: 1 })).toEqual({ type: "turnStart" });
    expect(translateDshEvent({ type: "turn/end", turn: 1, reason: "stop" })).toEqual({ type: "turnEnd" });
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

  it("step/start、todo/write 等中性域无对应 → null", () => {
    expect(translateDshEvent({ type: "step/start", turn: 1, step: 1 })).toBeNull();
    expect(translateDshEvent({ type: "todo/write", todos: [] })).toBeNull();
    expect(translateDshEvent({ type: "assistant/chunk", turn: 1, step: 1, chunk: {} })).toBeNull();
  });
});
