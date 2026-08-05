// flow-events 单元测试 —— 边界标记、消息流式归并、工具调用 ✓/✗ 归并、碎事件过滤。
import { describe, it, expect } from "vitest";
import { appendFlowEvent, type FlowEvent } from "./flow-events";

const T = 1_760_000_000_000;
let seq = 0;
const append = (list: FlowEvent[], type: string, event: unknown, ts = T): FlowEvent[] =>
  appendFlowEvent(list, type, event, ts, seq++);

const msg = (id: string, role: string, text: string) => ({ message: { id, role, content: text } });

describe("appendFlowEvent", () => {
  it("边界事件原样入列(agentStart/agentSettled 等)", () => {
    let l: FlowEvent[] = [];
    l = append(l, "agentStart", undefined);
    l = append(l, "agentSettled", undefined);
    expect(l.map((e) => [e.kind, e.text])).toEqual([
      ["boundary", "agentStart"],
      ["boundary", "agentSettled"],
    ]);
  });

  it("messageUpdate 同 messageId 归并同行递增,messageEnd 落定同行", () => {
    let l: FlowEvent[] = [];
    l = append(l, "messageStart", msg("m1", "assistant", ""));
    l = append(l, "messageUpdate", msg("m1", "assistant", "我先"));
    l = append(l, "messageUpdate", msg("m1", "assistant", "我先看 diff"), T + 1);
    l = append(l, "messageEnd", msg("m1", "assistant", "我先看 diff。"), T + 2);
    expect(l).toHaveLength(2);
    expect(l[1].text).toBe("我先看 diff。");
    expect(l[1].streaming).toBe(false);
  });

  it("messageUpdate 无可归并行时新增 streaming 行", () => {
    const l = append([], "messageUpdate", msg("m1", "assistant", "hello"));
    expect(l).toHaveLength(1);
    expect(l[0].streaming).toBe(true);
  });

  it("toolCallStart 新行,toolCallEnd 同行补 ✓;isError 补 ✗", () => {
    let l: FlowEvent[] = [];
    l = append(l, "toolCallStart", { toolCallId: "t1", toolName: "read" });
    l = append(l, "toolCallStart", { toolCallId: "t2", toolName: "bash" });
    l = append(l, "toolCallEnd", { toolCallId: "t1" });
    l = append(l, "toolCallEnd", { toolCallId: "t2", isError: true });
    expect(l.map((e) => e.text)).toEqual(["read ✓", "bash ✗"]);
  });

  it("toolCallEnd 找不到 start 时单行补标", () => {
    const l = append([], "toolCallEnd", { toolCallId: "ghost" });
    expect(l.map((e) => e.text)).toEqual(["✓"]);
  });

  it("碎事件(toolCallUpdate/turn 之外未列名者)不进面板", () => {
    let l: FlowEvent[] = [];
    l = append(l, "toolCallUpdate", { toolCallId: "t1", partialResult: "..." });
    l = append(l, "messageAutoRetry", {});
    expect(l).toHaveLength(0);
  });
});
