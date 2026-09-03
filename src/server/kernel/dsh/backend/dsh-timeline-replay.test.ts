// dsh 多步回合(思考+工具调用+作答)的全链证明:内核事件流 → 中性事件 → 中立层条目
// → 镜像读口(壳渲染消费的同一推导) → 块分解,最终 thinking / toolCall / text 三类块
// 一个不少(用户报告「工具调用、思考都不展示」的反向钉——链路在哪一环断,这个测试
// 就在哪一环红)。
//
// 事件序列照抄真实 dsh 日志的形状(reasoning-chunks 批式 + tool/call + tool/result +
// assistant/message 终态),不依赖真实模型。
// 会话单源(session-single-source)后,内容路径 = 翻译器 → 中立层(messageEnd 写穿)
// → 镜像读口(neutralMessagesOfSession,与渲染层同一函数)——本测试钉的正是这条新链。
import { describe, it, expect } from "vitest";
import { createDshEventTranslator } from "./dsh-event-translator";
import { decomposeMessage } from "../../../../plugins/sessions/timeline/renderer/blocks";
import { emptyNeutralSession, appendNeutralEntry, neutralMessagesOfSession } from "@my-harness-desktop/shared";
import type { NeutralMessage, NeutralSession } from "@my-harness-desktop/shared";

/** 把翻译器产出的中性事件按壳写穿语义落中立层(messageEnd → 条目;与 dispatch 同语义的最小模拟)。 */
function writeThrough(session: NeutralSession, events: { type: string; message?: NeutralMessage }[]): NeutralSession {
  let cur = session;
  for (const e of events) {
    if (e.type === "messageEnd" && e.message) {
      cur = appendNeutralEntry(cur, "root", { neutralEntryId: "", kernelEntryId: e.message.id, message: e.message });
    }
  }
  return cur;
}

describe("dsh 多步回合全链:思考+工具调用+作答都进渲染面(问题13守卫)", () => {
  it("思考链 + 工具卡 + 文本块在终态消息里齐备(经中立层镜像读口)", () => {
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

    // 翻译器 → 中性事件 → 写穿中立层(与主侧 dispatch 同语义)
    let session = emptyNeutralSession("ns", { kernel: "dsh", cwd: "/p", createdAt: "t" });
    for (const e of events) {
      const neutral = t(e);
      session = writeThrough(session, neutral as { type: string; message?: NeutralMessage }[]);
    }

    // 镜像读口(与渲染层同一推导,契约单源):活跃 lineage 的消息视图
    const messages = neutralMessagesOfSession(session, "root");

    // 找到 assistant 终态消息
    const asst = messages.filter((m) => m.role === "assistant");
    expect(asst.length).toBeGreaterThan(0);
    const last = asst[asst.length - 1];
    // 无 pending 残留(问题2 不复发)
    expect(messages.filter((m) => m.pending === true)).toHaveLength(0);

    // 块分解:thinking + toolCall + text 三类都在
    const blocks = decomposeMessage(last, [], new Set());
    const kinds = (blocks ?? []).map((b) => b.type);
    expect(kinds).toContain("thinking"); // 思考链展示
    expect(kinds).toContain("toolCall"); // 工具卡展示
    expect(kinds).toContain("text"); // 作答文本展示
  });
});
