// working-phase 单元测试 —— WorkingPhase 推导纯函数(设计 docs/design/session-working-phase.md §1.2)。
// 圆心纯函数,零 mock(docs/test/testing-strategy.md §3:domain 测试 95%+ 目标)。
// 覆盖三件事:phaseFromMessage 优先级、phaseFromView 组合逻辑、advancePhase 转移表。
import { describe, it, expect } from "vitest";
import { phaseFromMessage, phaseFromView, advancePhase } from "./working-phase";
import type { NeutralMessage } from "./events/session-state";

/** 构造 assistant 消息(content 为内容块数组或字符串)。 */
function msg(content: unknown, pending?: boolean, id = "m1"): NeutralMessage {
  return { id, role: "assistant", content, pending } as NeutralMessage;
}
const thinking = { type: "thinking", thinking: "想…" };
const text = { type: "text", text: "输出" };
const toolPending = { type: "toolCall", id: "t1", name: "bash", args: {}, state: "pending" };
const toolRunning = { type: "toolCall", id: "t1", name: "bash", args: {}, state: "running" };
const toolDone = { type: "toolCall", id: "t1", name: "bash", args: {}, state: "done", result: "ok" };

describe("phaseFromMessage: 消息内容 → 阶段(优先级判定)", () => {
  it("toolCall pending/running 优先于 thinking/text", () => {
    expect(phaseFromMessage([toolRunning, thinking, text])).toBe("toolExecuting");
    expect(phaseFromMessage([toolPending, thinking, text])).toBe("toolExecuting");
  });
  it("有 text 优先于 thinking(thinking 块定型保留在 content 里,已出文本即输出中)", () => {
    expect(phaseFromMessage([thinking, text])).toBe("outputting");
  });
  it("只有 thinking 块 → thinking", () => {
    expect(phaseFromMessage([thinking])).toBe("thinking");
  });
  it("空 content / 未知块 / 已完成 toolCall 块 → requesting(保守视为模型在处理)", () => {
    expect(phaseFromMessage([])).toBe("requesting");
    expect(phaseFromMessage(undefined)).toBe("requesting");
    expect(phaseFromMessage([{ type: "custom", data: 1 }])).toBe("requesting");
    expect(phaseFromMessage([toolDone])).toBe("requesting");
  });
  it("字符串 content 有文本 → outputting,空串 → requesting", () => {
    expect(phaseFromMessage("hello")).toBe("outputting");
    expect(phaseFromMessage("")).toBe("requesting");
  });
});

describe("phaseFromView: 快照式组合逻辑", () => {
  it("覆盖态优先于一切内容推导", () => {
    expect(phaseFromView([msg([thinking], true)], true, { retrying: true })).toBe("retrying");
    expect(phaseFromView([msg([thinking], true)], true, { compacting: true })).toBe("compacting");
  });
  it("不流式 → idle(即便有 pending 残留)", () => {
    expect(phaseFromView([msg([thinking], true)], false)).toBe("idle");
  });
  it("末条 pending 消息定阶段", () => {
    expect(phaseFromView([msg([thinking], true)], true)).toBe("thinking");
    expect(phaseFromView([msg([toolRunning], true)], true)).toBe("toolExecuting");
    expect(phaseFromView([msg([text], true)], true)).toBe("outputting");
  });
  it("只认 pending 消息:上一轮已定稿(pending=false)不算,否则第二轮开始误报上一轮 outputting", () => {
    const lastRoundDone = msg([thinking, text], false);
    expect(phaseFromView([lastRoundDone], true)).toBe("requesting");
  });
  it("streaming 但无任何 pending 消息(agentStart 后空窗/两轮之间)→ requesting", () => {
    expect(phaseFromView([], true)).toBe("requesting");
    expect(phaseFromView([msg([text], false)], true)).toBe("requesting");
  });
});

describe("advancePhase: 增量式转移表", () => {
  it("agentStart → requesting(轮次开始,等首 token)", () => {
    expect(advancePhase("idle", { type: "agentStart" })).toBe("requesting");
  });
  it("messageStart/messageUpdate 按消息内容定阶段", () => {
    expect(advancePhase("requesting", { type: "messageStart", message: msg([thinking], true) })).toBe("thinking");
    expect(advancePhase("thinking", { type: "messageUpdate", message: msg([text], true) })).toBe("outputting");
    expect(advancePhase("requesting", { type: "messageStart", message: msg([toolRunning], true) })).toBe("toolExecuting");
  });
  it("messageEnd → requesting(AI 思考下一步,agentSettled 随后纠正)", () => {
    expect(advancePhase("outputting", { type: "messageEnd", message: msg([text], false) })).toBe("requesting");
  });
  it("entryAppended 保持原阶段(落盘回执)", () => {
    expect(advancePhase("thinking", { type: "entryAppended", entry: { id: "e1" } })).toBe("thinking");
  });
  it("toolCallStart → toolExecuting;toolCallEnd → requesting", () => {
    expect(advancePhase("requesting", { type: "toolCallStart", toolCallId: "t1", toolName: "bash" })).toBe("toolExecuting");
    expect(advancePhase("toolExecuting", { type: "toolCallEnd", toolCallId: "t1", result: "ok" })).toBe("requesting");
  });
  it("autoRetryStart → retrying;autoRetryEnd success=false → idle,success=true 保持(后续事件推进)", () => {
    expect(advancePhase("outputting", { type: "autoRetryStart", attempt: 1, maxAttempts: 3 })).toBe("retrying");
    expect(advancePhase("retrying", { type: "autoRetryEnd", success: false })).toBe("idle");
    expect(advancePhase("retrying", { type: "autoRetryEnd", success: true })).toBe("retrying");
  });
  it("compactionStart → compacting;compactionEnd → requesting", () => {
    expect(advancePhase("outputting", { type: "compactionStart" })).toBe("compacting");
    expect(advancePhase("compacting", { type: "compactionEnd" })).toBe("requesting");
  });
  it("agentEnd/agentSettled 权威归 idle(同帧双发、机制等价)", () => {
    expect(advancePhase("requesting", { type: "agentEnd" })).toBe("idle");
    expect(advancePhase("outputting", { type: "agentSettled" })).toBe("idle");
  });
  it("未知事件保持原阶段", () => {
    expect(advancePhase("thinking", { type: "queueUpdate", pendingMessageCount: 1 })).toBe("thinking");
  });
});
