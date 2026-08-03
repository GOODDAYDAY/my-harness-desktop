// applyEvent 单元测试 —— 针对「entryAppended 按身份去重」根因修复。
// renderer 侧 session-store 的事件增量应用纯函数(L1.5 范式)。
// 修复前:非消息条目用 textOf(content) 判重,divider content 恒 "" →
// 任意两条 divider 互判重复,后到的 model/thinking 分隔线被吞。
import { describe, it, expect } from "vitest";
import { applyEvent } from "./session-store";
import { sessionEntryToNeutral, type NeutralMessage, type SessionEvent } from "@pi-desktop/contract";

function n(entry: Record<string, unknown>): NeutralMessage {
  const m = sessionEntryToNeutral(entry);
  if (!m) throw new Error("fixture entry 应映射为非空消息");
  return m;
}

/** 底座 entry_appended 事件载荷(事件流里 entry 字段就是 JSONL 行形状)。 */
function entryAppended(entry: Record<string, unknown>): SessionEvent {
  return { type: "entryAppended", entry } as unknown as SessionEvent;
}

const modelEntry = (id: string) => ({
  type: "model_change", id, parentId: null,
  timestamp: "2026-08-03T15:12:42.516Z",
  provider: "apps-studio", modelId: "anthropic/qwen3.7-max",
});
const thinkingEntry = (id: string, parentId: string, level = "low") => ({
  type: "thinking_level_change", id, parentId,
  timestamp: "2026-08-03T15:12:42.516Z", thinkingLevel: level,
});

describe("applyEvent → entryAppended: divider 身份判重(根因修复回归)", () => {
  it("修复核心:model divider 之后再收 thinking divider,两条都在", () => {
    let msgs: NeutralMessage[] = [];
    msgs = applyEvent(msgs, entryAppended(modelEntry("2cc75520")));
    msgs = applyEvent(msgs, entryAppended(thinkingEntry("68820d2f", "2cc75520")));
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.kind)).toEqual(["model", "thinking"]);
  });

  it("同一 entry 被底座重推(同 id)仍去重", () => {
    let msgs: NeutralMessage[] = [];
    msgs = applyEvent(msgs, entryAppended(thinkingEntry("e1", null, "low")));
    msgs = applyEvent(msgs, entryAppended(thinkingEntry("e1", null, "low"))); // 重推
    expect(msgs).toHaveLength(1);
  });

  it("两条 id 缺失但 kind+i18nKey+i18nArgs 完全相同的相邻 divider 去重", () => {
    // 底座 entry 恒带 id;此路径是防御性回退(手工构造无 id 场景)
    let msgs: NeutralMessage[] = [n({ type: "thinking_level_change", thinkingLevel: "low" })];
    msgs = applyEvent(msgs, entryAppended({ type: "thinking_level_change", thinkingLevel: "low" }));
    expect(msgs).toHaveLength(1);
  });

  it("同 kind 不同 level(用户高→低连改)不互判,两条都追加", () => {
    let msgs: NeutralMessage[] = [];
    msgs = applyEvent(msgs, entryAppended(thinkingEntry("e1", null, "high")));
    msgs = applyEvent(msgs, entryAppended(thinkingEntry("e2", null, "low")));
    expect(msgs).toHaveLength(2);
  });
});

describe("applyEvent → entryAppended: 原有语义无回归", () => {
  it("message 条目按文本匹配回填权威 entryId(id 水合)", () => {
    let msgs: NeutralMessage[] = [
      { role: "assistant", content: "回复内容", pending: false } as NeutralMessage,
    ];
    msgs = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-xyz",
      message: { role: "assistant", content: "回复内容" },
    }));
    expect(msgs).toHaveLength(1); // 不追加新消息
    expect(msgs[0].id).toBe("entry-xyz"); // 只水合 id
  });

  it("entry 映射为 null(custom/session 型)时不改动消息流;未知类型按兜底分隔线追加", () => {
    const before: NeutralMessage[] = [n(modelEntry("m1"))];
    // 无 entry 字段:直接 return messages
    expect(applyEvent(before, { type: "entryAppended" } as unknown as SessionEvent)).toBe(before);
    // custom/session 型映射 null:不追加
    expect(applyEvent(before, entryAppended({ type: "custom", data: {} }))).toBe(before);
    // 未知类型:兜底成 unknownEntry 分隔线追加(session-state.ts:338 设计内行为)
    const after = applyEvent(before, entryAppended({}));
    expect(after).toHaveLength(2);
    expect(after[1].kind).toBe("entry");
    expect(after[1].i18nKey).toBe("timeline.unknownEntry");
  });

  it("messageStart/Update/End 主流程不受影响", () => {
    let msgs: NeutralMessage[] = [];
    msgs = applyEvent(msgs, {
      type: "messageStart",
      message: { id: "a1", role: "assistant", content: "" },
    } as unknown as SessionEvent);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].pending).toBe(true);

    msgs = applyEvent(msgs, {
      type: "messageUpdate",
      message: { id: "a1", role: "assistant", content: "流式片段" },
    } as unknown as SessionEvent);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("流式片段");
    expect(msgs[0].pending).toBe(true); // Update 绝不清 pending(注释契约)

    msgs = applyEvent(msgs, {
      type: "messageEnd",
      message: { id: "a1", role: "assistant", content: "流式片段" },
    } as unknown as SessionEvent);
    expect(msgs[0].pending).toBe(false);
  });
});
