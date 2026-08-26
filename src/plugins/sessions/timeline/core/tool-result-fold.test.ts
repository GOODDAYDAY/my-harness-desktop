// tool-result-fold 行为验证:与真实会话文件形状对齐(底座 assistant 块无 result、
// 独立 toolResult 消息挂 toolCallId,样本源自 ~/.pi/agent/sessions 实测)。
import { describe, it, expect } from "vitest";
import { foldToolResults } from "./tool-result-fold";
import type { NeutralMessage } from "@my-harness-desktop/shared";

const msg = (extra: Record<string, unknown>): NeutralMessage => ({ content: "", ...extra }) as NeutralMessage;

const assistantWithCall = (id: string, name: string, args: unknown) =>
  msg({ role: "assistant", content: [{ type: "toolCall", id, name, args }] });

const toolResult = (toolCallId: string | undefined, toolName: string, text: string, extra: Record<string, unknown> = {}) =>
  msg({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], ...extra });

describe("foldToolResults", () => {
  it("配对折叠:结果写回工具块,toolResult 消息摘除", () => {
    const call = assistantWithCall("bash:0", "bash", { command: "ls" });
    const ret = toolResult("bash:0", "bash", "file1\nfile2");
    const out = foldToolResults([call, ret]);

    expect(out).toHaveLength(1);
    const blocks = (out[0].content as Record<string, unknown>[]);
    expect(blocks[0]).toMatchObject({
      type: "toolCall", id: "bash:0", name: "bash",
      result: [{ type: "text", text: "file1\nfile2" }], isError: false,
    });
  });

  it("isError 透传:toolResult.isError=true 落到 block.isError", () => {
    const out = foldToolResults([
      assistantWithCall("read:1", "read", { path: "/a" }),
      toolResult("read:1", "read", "boom", { isError: true }),
    ]);
    expect((out[0].content as Record<string, unknown>[])[0]).toMatchObject({ isError: true });
  });

  it("block 已有 result(live 流式回填)不覆写,toolResult 仍摘除(同一结果的第二份展示)", () => {
    const call = msg({
      role: "assistant",
      content: [{ type: "toolCall", id: "bash:0", name: "bash", args: {}, result: "已有结果" }],
    });
    const out = foldToolResults([call, toolResult("bash:0", "bash", "落盘结果")]);
    expect(out).toHaveLength(1);
    expect((out[0].content as Record<string, unknown>[])[0].result).toBe("已有结果");
  });

  it("孤儿 toolResult(toolCallId 无命中,如 fork 截断历史)原样保留", () => {
    const orphan = toolResult("ghost:9", "bash", "output");
    const out = foldToolResults([assistantWithCall("bash:0", "bash", {}), orphan]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(orphan);
  });

  it("孤儿 toolResult(缺 toolCallId)原样保留", () => {
    const orphan = toolResult(undefined, "bash", "output");
    const out = foldToolResults([assistantWithCall("bash:0", "bash", {}), orphan]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(orphan);
  });

  it("多个调用乱序配对:按 id 各自归位而非按位置", () => {
    const out = foldToolResults([
      assistantWithCall("a:0", "bash", { command: "one" }),
      toolResult("b:0", "read", "先到的其实是第二个调用的结果"),
      assistantWithCall("b:0", "read", { path: "/x" }),
      toolResult("a:0", "bash", "one-out"),
    ]);
    expect(out).toHaveLength(2);
    expect((out[0].content as Record<string, unknown>[])[0].result).toEqual([{ type: "text", text: "one-out" }]);
    expect((out[1].content as Record<string, unknown>[])[0].result).toEqual([{ type: "text", text: "先到的其实是第二个调用的结果" }]);
  });

  it("一条 assistant 多个工具块:逐块配对,互不串扰", () => {
    const call = msg({
      role: "assistant",
      content: [
        { type: "toolCall", id: "bash:0", name: "bash", args: {} },
        { type: "toolCall", id: "read:0", name: "read", args: {} },
        { type: "text", text: "收尾" },
      ],
    });
    const out = foldToolResults([
      call,
      toolResult("read:0", "read", "文件内容"),
      toolResult("bash:0", "bash", "ls-out"),
    ]);
    expect(out).toHaveLength(1);
    const blocks = out[0].content as Record<string, unknown>[];
    expect(blocks[0].result).toEqual([{ type: "text", text: "ls-out" }]);
    expect(blocks[1].result).toEqual([{ type: "text", text: "文件内容" }]);
    expect(blocks[2]).toEqual({ type: "text", text: "收尾" });
  });

  it("不可变:输入数组与消息对象引用未被修改(MessageRow memo 依赖)", () => {
    const call = assistantWithCall("bash:0", "bash", { command: "ls" });
    const ret = toolResult("bash:0", "bash", "out");
    const callContent = call.content;
    const callBlock = (callContent as unknown[])[0];
    const out = foldToolResults([call, ret]);
    expect(call.content).toBe(callContent);
    expect((callContent as unknown[])[0]).toBe(callBlock);
    expect((callBlock as Record<string, unknown>).result).toBeUndefined();
    expect(out[0]).not.toBe(call);
  });

  it("无工具调用的会话走快路径:原数组引用返回,零分配", () => {
    const list = [msg({ role: "user", content: "hi" }), msg({ role: "assistant", content: "hello" })];
    expect(foldToolResults(list)).toBe(list);
  });

  it("pending 的流式 assistant 也照常折叠(live 路径与文件路径同一变换)", () => {
    const call = msg({ role: "assistant", pending: true, content: [{ type: "toolCall", id: "bash:0", name: "bash", args: {} }] });
    const out = foldToolResults([call, toolResult("bash:0", "bash", "done")]);
    expect(out).toHaveLength(1);
    expect((out[0].content as Record<string, unknown>[])[0].result).toEqual([{ type: "text", text: "done" }]);
  });
});
