// `session-state.ts` 的 5 个纯函数（r149；此前零测试引用）。
//
// ## 为什么这一族值得测
//
// 它们决定**用户看得见什么**：
// · `isVisibleMessage` 是消息可见性的总闸——语义是「**缺省即可见**」（`display !== false`）。
//   若哪天有人改成 `display === true`，所有没显式带 `display` 字段的消息会**全部消失**，
//   而这类回归在 UI 上表现为"会话空了"，极难归因到这一行。
// · `toolCallsOf` / `thinkingBlocksOf` 从**内核给的 unknown content** 里挑块并归一——
//   内核查的形状不由我们控制（缺字段、多字段、类型不对都可能），
//   归一化错了会让工具卡片错位或思考块丢失。
// · `withNormalizedToolCalls` 把内核的 `arguments` 字段改写成中性的 `args`
//   （协议差异的翻译点），且**不该改的时候必须原样返回同一对象**（引用相等 = 不触发重渲染）。
// · `shellSessionStats` 用壳侧本地统计补齐一个完整的 SessionStats 形状。
//
// ⚠ 按 r141/r143/r147/r148 的纪律覆盖两侧：该归一的归一、**不该动的一动不动**（引用相等）。

import { describe, it, expect } from "vitest";
import {
  shellSessionStats, toolCallsOf, thinkingBlocksOf, withNormalizedToolCalls, isVisibleMessage,
} from "./session-state";

describe("isVisibleMessage：可见性总闸（缺省即可见）", () => {
  const msg = (display?: boolean) => ({ role: "user", display } as never);

  it("① display 缺省 ⇒ **可见**（绝大多数消息不带这个字段）", () => {
    expect(isVisibleMessage(msg(undefined))).toBe(true);
  });
  it("② display=true ⇒ 可见；display=false ⇒ 隐藏", () => {
    expect(isVisibleMessage(msg(true))).toBe(true);
    expect(isVisibleMessage(msg(false))).toBe(false);
  });
  it("③ 钉桩：判据是 `!== false` 而不是 `=== true`（改成语义相反时这条会红）", () => {
    // 若实现退化成 `msg.display === true`，①会失败——这正是本测试存在的理由。
    expect(isVisibleMessage({ role: "assistant" } as never), "没有 display 字段的消息必须可见").toBe(true);
  });
});

describe("toolCallsOf：从 unknown content 里挑出 toolCall 块并归一", () => {
  it("① 非数组（字符串/null/undefined/对象）⇒ 空数组，不抛", () => {
    for (const bad of ["text", null, undefined, 42, { type: "toolCall" }]) {
      expect(toolCallsOf(bad)).toEqual([]);
    }
  });
  it("② 只挑 type==='toolCall' 的块，其余（text/thinking）忽略且**顺序保持**", () => {
    const out = toolCallsOf([
      { type: "text", text: "hi" },
      { type: "toolCall", name: "bash", id: "t1" },
      { type: "thinking", thinking: "…" },
      { type: "toolCall", name: "read", id: "t2" },
    ]);
    expect(out.map((c) => c.name)).toEqual(["bash", "read"]);
    expect(out.map((c) => c.id)).toEqual(["t1", "t2"]);
  });
  it("③ 缺字段有**默认值**：name 缺省为 'tool'，isError 缺省为 false，id/state 缺省为 undefined", () => {
    const [c] = toolCallsOf([{ type: "toolCall" }]);
    expect(c).toEqual({ id: undefined, name: "tool", args: undefined, state: undefined, result: undefined, isError: false });
  });
  it("④ 类型不对的字段被归一：id/state 非字符串 ⇒ undefined；isError 只有严格 true 才算错", () => {
    const [c] = toolCallsOf([{ type: "toolCall", name: "x", id: 123, state: 5, isError: "yes" }]);
    expect(c.id, "非字符串 id 不该原样透传（下游拿它当 key）").toBeUndefined();
    expect(c.state).toBeUndefined();
    expect(c.isError, "isError:'yes' 不该被当成 true（严格比较）").toBe(false);
  });
  it("⑤ 数组里混入 null/字符串/数字 ⇒ 跳过而不抛", () => {
    expect(toolCallsOf([null, "x", 7, { type: "toolCall", name: "ok" }])).toHaveLength(1);
  });
});

describe("thinkingBlocksOf：思考块归一（含 redacted 与签名字段）", () => {
  it("① 非数组 ⇒ 空数组", () => {
    expect(thinkingBlocksOf(null)).toEqual([]);
    expect(thinkingBlocksOf("thinking")).toEqual([]);
  });
  it("② 正文取 thinking，缺则回落 text，再缺则空串（两种内核字段名都认）", () => {
    expect(thinkingBlocksOf([{ type: "thinking", thinking: "A" }])[0].thinking).toBe("A");
    expect(thinkingBlocksOf([{ type: "thinking", text: "B" }])[0].thinking, "text 是回落来源").toBe("B");
    expect(thinkingBlocksOf([{ type: "thinking" }])[0].thinking).toBe("");
  });
  it("③ redacted 只有严格 true 才算；thinkingSignature 非字符串 ⇒ undefined", () => {
    const [a] = thinkingBlocksOf([{ type: "thinking", thinking: "x", redacted: "true", thinkingSignature: 9 }]);
    expect(a.redacted).toBe(false);
    expect(a.thinkingSignature).toBeUndefined();
    const [b] = thinkingBlocksOf([{ type: "thinking", thinking: "x", redacted: true, thinkingSignature: "sig" }]);
    expect(b.redacted).toBe(true);
    expect(b.thinkingSignature).toBe("sig");
  });
  it("④ 只挑 thinking 块，且 type 字段被强制成 'thinking'（下游按它分派渲染）", () => {
    const out = thinkingBlocksOf([{ type: "text", text: "hi" }, { type: "thinking", thinking: "T" }]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("thinking");
  });
});

describe("withNormalizedToolCalls：arguments → args 的协议翻译（不该动时一动不动）", () => {
  it("① content 不是数组 ⇒ **原样返回同一对象**（引用相等，不触发重渲染）", () => {
    const m = { role: "assistant", content: "纯文本" };
    expect(withNormalizedToolCalls(m)).toBe(m);
  });
  it("② 有 toolCall 带 arguments 而无 args ⇒ 复制成 args，且返回**新对象**（不修改入参）", () => {
    const m = { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } }] };
    const snapshot = JSON.stringify(m);
    const out = withNormalizedToolCalls(m);
    expect((out.content[0] as Record<string, unknown>).args).toEqual({ cmd: "ls" });
    expect((out.content[0] as Record<string, unknown>).arguments, "原字段保留（只补 args，不删）").toEqual({ cmd: "ls" });
    expect(out, "有改动就该是新对象").not.toBe(m);
    expect(JSON.stringify(m), "纯函数不得修改入参").toBe(snapshot);
  });
  it("③ **不该动的情形都原样返回同一对象**：已有 args / 无 arguments / 不是 toolCall 块", () => {
    const hasArgs = { content: [{ type: "toolCall", args: { a: 1 } }] };
    const noArgsField = { content: [{ type: "toolCall", name: "x" }] };
    const textOnly = { content: [{ type: "text", text: "hi" }] };
    expect(withNormalizedToolCalls(hasArgs)).toBe(hasArgs);
    expect(withNormalizedToolCalls(noArgsField)).toBe(noArgsField);
    expect(withNormalizedToolCalls(textOnly)).toBe(textOnly);
  });
  it("④ args 显式为 undefined 而 arguments 有值 ⇒ 仍然翻译（判据是 args !== undefined）", () => {
    const m = { content: [{ type: "toolCall", args: undefined, arguments: { b: 2 } }] };
    const out = withNormalizedToolCalls(m);
    expect((out.content[0] as Record<string, unknown>).args).toEqual({ b: 2 });
  });
  it("⑤ content 里混入 null/字符串 ⇒ 跳过而不抛，且整体不变时仍返回同一对象", () => {
    const m = { content: [null, "x", 3] };
    expect(withNormalizedToolCalls(m)).toBe(m);
  });
});

describe("shellSessionStats：壳侧本地统计补齐完整 SessionStats 形状", () => {
  const local = {
    tps: 12.5,
    // ⚠ TurnUsage 的字段是 input/output/cacheRead/cacheWrite/**cost**（没有 total——
    //   r149 首版按直觉写了 total，被 tsc 当场纠正；总量在 SessionStats.tokens.total 上）
    turn: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    lastTurn: null,
    turns: 3,
    steps: 7,
  };

  it("① 本地字段**优先**（展开顺序在默认值之后，所以本地值覆盖 0）", () => {
    const s = shellSessionStats(local);
    expect(s.tps).toBe(12.5);
    expect(s.turns).toBe(3);
    expect(s.steps).toBe(7);
    expect(s.turn?.input, "turn 在 SessionStats 里是可选字段，故用 ?. 读").toBe(10);
    expect(s.turn?.cost).toBe(0.01);
    expect(s.lastTurn).toBeNull();
  });
  it("② 壳侧不统计的字段补 0/空（消息数与 token 由内核侧填，壳不伪造）", () => {
    const s = shellSessionStats(local);
    expect(s.userMessages).toBe(0);
    expect(s.assistantMessages).toBe(0);
    expect(s.toolCalls).toBe(0);
    expect(s.toolResults).toBe(0);
    expect(s.totalMessages).toBe(0);
    expect(s.cost).toBe(0);
    expect(s.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    // ⚠ 注意区分两个 total：TurnUsage 没有 total（只有 cost），SessionStats.tokens 才有 total
  });
  it("③ 不修改入参（纯函数）", () => {
    const input = { ...local, turn: { ...local.turn } };
    const snapshot = JSON.stringify(input);
    shellSessionStats(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
