// deduplicateAdjacent 单元测试 —— 针对「相邻 divider 判重」根因修复。
// 圆心纯函数,零 mock(docs/test/testing-strategy.md §3:domain 测试 95%+ 目标)。
// 数据形状取自真实会话 JSONL(~/.pi/agent/sessions/.../2026-08-03T15-12-41 文件实测):
//   model_change 与 thinking_level_change entry 相邻写入,经 sessionEntryToNeutral
//   后两条 divider 相邻——修复前第二条必被吞。
import { describe, it, expect } from "vitest";
import {
  sessionEntryToNeutral, deduplicateAdjacent, messageUsageOf,
  buildBranchPath, estimateMessageTokens, estimateContextTokens, branchContextTokens,
  type NeutralMessage,
} from "./session-state";

/** 按真实 JSONL 形状构造 entry → NeutralMessage(与 resync/文件读同一条映射路径)。 */
function n(entry: Record<string, unknown>): NeutralMessage {
  const m = sessionEntryToNeutral(entry);
  if (!m) throw new Error("fixture entry 应映射为非空消息");
  return m;
}

const modelEntry = (id: string, provider = "apps-studio", modelId = "anthropic/qwen3.7-max") => ({
  type: "model_change", id, parentId: null,
  timestamp: "2026-08-03T15:12:42.516Z", provider, modelId,
});
const thinkingEntry = (id: string, parentId: string | null, level = "low") => ({
  type: "thinking_level_change", id, parentId,
  timestamp: "2026-08-03T15:12:42.516Z", thinkingLevel: level,
});
const userEntry = (id: string, text: string) => ({
  type: "message", id, timestamp: "2026-08-03T15:13:00.000Z",
  message: { role: "user", content: text },
});

describe("deduplicateAdjacent: divider 相邻判重(根因修复回归)", () => {
  it("修复核心:model + thinking 相邻 divider 全部保留", () => {
    const out = deduplicateAdjacent([
      n(modelEntry("2cc75520")),
      n(thinkingEntry("68820d2f", "2cc75520")),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("model");
    expect(out[1].kind).toBe("thinking");
    expect(out[1].i18nArgs).toEqual({ level: "low" });
  });

  it("真实文件序列:model,thinking,model(同模型)——三条全保留", () => {
    // 真实 JSONL 第 2-4 行:换 thinking 时底座顺带重写一条同模型 model_change
    const out = deduplicateAdjacent([
      n(modelEntry("2cc75520")),
      n(thinkingEntry("68820d2f", "2cc75520")),
      n(modelEntry("8dd0db7d")),
    ]);
    expect(out).toHaveLength(3);
  });

  it("底座重写同一条 entry(同 kind+i18nKey+i18nArgs 相邻)仍判重合并", () => {
    const out = deduplicateAdjacent([
      n(thinkingEntry("a1", null, "high")),
      n(thinkingEntry("a2", null, "high")), // id 不同但内容完全相同的相邻重推
    ]);
    expect(out).toHaveLength(1);
  });

  it("同 kind 不同 level 的相邻 thinking divider 不判重(高→低 连续切换)", () => {
    const out = deduplicateAdjacent([
      n(thinkingEntry("a1", null, "high")),
      n(thinkingEntry("a2", null, "low")),
    ]);
    expect(out).toHaveLength(2);
  });

  it("divider 被消息隔开时原本就不判重,行为不变", () => {
    const out = deduplicateAdjacent([
      n(modelEntry("m1")),
      n(userEntry("u1", "你好")),
      n(modelEntry("m1")),
    ]);
    expect(out).toHaveLength(3);
  });
});

describe("deduplicateAdjacent: 重试失败落盘不去重(根因修复回归)", () => {
  // 数据形状取自真实会话"测试1123"(2026-08-04T07-18-27 文件实测):
  // 底座自动重试每次失败落盘一条 stopReason:"error" 空 assistant,连续 9 条。
  const errorEntry = (id: string) => ({
    type: "message", id, timestamp: "2026-08-04T07:20:00.000Z",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." },
  });

  it("9 条连续空 error assistant 全保留(每条是独立失败事件,非重复写入)", () => {
    const out = deduplicateAdjacent(Array.from({ length: 9 }, (_, i) => n(errorEntry(`e${i}`))));
    expect(out).toHaveLength(9);
    expect(out.every((m) => m.error === true)).toBe(true);
  });

  it("aborted 消息不受影响:相邻同内容 aborted 仍按原规则判重", () => {
    const abortedEntry = (id: string) => ({
      type: "message", id, timestamp: "2026-08-04T07:20:00.000Z",
      message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted." },
    });
    const out = deduplicateAdjacent([n(abortedEntry("a1")), n(abortedEntry("a2"))]);
    expect(out).toHaveLength(1);
  });
});

describe("deduplicateAdjacent: 原有语义无回归", () => {
  it("相邻两条完全相同的 user 消息仍合并", () => {
    const out = deduplicateAdjacent([
      n(userEntry("u1", "同样的文本")),
      n(userEntry("u2", "同样的文本")),
    ]);
    expect(out).toHaveLength(1);
  });

  it("相邻两条不同 user 消息保留", () => {
    const out = deduplicateAdjacent([
      n(userEntry("u1", "第一条")),
      n(userEntry("u2", "第二条")),
    ]);
    expect(out).toHaveLength(2);
  });

  it("非标准角色(custom_message 衍生)全量去重逻辑不受影响", () => {
    const cm = (id: string) => n({
      type: "custom_message", id, customType: "bashExecution", content: "same-cmd",
    });
    const out = deduplicateAdjacent([cm("c1"), n(userEntry("u1", "隔开")), cm("c2")]);
    // 非标准角色按 role::content 全量去重(不要求相邻) → 第二条被合并
    expect(out.filter((m) => m.role === "bashExecution")).toHaveLength(1);
    expect(out).toHaveLength(2);
  });
});

describe("sessionEntryToNeutral: divider 映射(修复依赖的字段契约)", () => {
  it("thinking_level_change → divider(thinking),content 恒空串,id 提升", () => {
    const m = n(thinkingEntry("68820d2f", "2cc75520", "minimal"));
    expect(m.role).toBe("divider");
    expect(m.kind).toBe("thinking");
    expect(m.i18nKey).toBe("timeline.thinkingLevel");
    expect(m.i18nArgs).toEqual({ level: "minimal" });
    expect(m.content).toBe(""); // 判重不能用 content 的根因所在
    expect(m.id).toBe("68820d2f");
  });

  it("model_change → divider(model),provider/modelId 入 i18nArgs", () => {
    const m = n(modelEntry("2cc75520", "apps-studio-local", "bifrost/anthropic_localnode_1/local-glm-5.2"));
    expect(m.role).toBe("divider");
    expect(m.kind).toBe("model");
    expect(m.i18nKey).toBe("timeline.modelChange");
    expect(m.i18nArgs).toEqual({
      provider: "apps-studio-local",
      modelId: "bifrost/anthropic_localnode_1/local-glm-5.2",
    });
    expect(m.content).toBe("");
  });
});

// ============ 上下文估算(文件基线对齐底座口径,设计 session-stats-alignment.md §3)============

/** 原始 JSONL message entry(branchContextTokens / buildBranchPath 的入参形状)。 */
const msgEntry = (id: string, parentId: string | null, message: Record<string, unknown>) => ({
  type: "message", id, parentId, timestamp: "2026-08-06T00:00:00.000Z", message,
});
const assistantWithUsage = (id: string, parentId: string | null, totalTokens: number, extra: Record<string, unknown> = {}) =>
  msgEntry(id, parentId, {
    role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop",
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens }, ...extra,
  });
const compactionEntry = (id: string, parentId: string | null) => ({
  type: "compaction", id, parentId, timestamp: "2026-08-06T00:00:00.000Z", summary: "摘要", tokensBefore: 99999,
});

describe("buildBranchPath: 激活分支重建(底座 buildSessionPath 默认行为)", () => {
  it("线性会话:全序列即路径,根→叶顺序", () => {
    const e1 = msgEntry("a", null, { role: "user", content: "x" });
    const e2 = msgEntry("b", "a", { role: "assistant", content: [] });
    const e3 = msgEntry("c", "b", { role: "user", content: "y" });
    expect(buildBranchPath([e1, e2, e3]).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("分支会话:leaf 取文件末条,废弃分支不进路径", () => {
    const e1 = msgEntry("a", null, { role: "user", content: "x" });
    const e2 = msgEntry("b", "a", { role: "assistant", content: [] });
    const e3 = msgEntry("c", "b", { role: "user", content: "废弃分支" });
    const e4 = msgEntry("d", "b", { role: "user", content: "激活分支" });
    expect(buildBranchPath([e1, e2, e3, e4]).map((e) => e.id)).toEqual(["a", "b", "d"]);
  });

  it("孤儿 entry:父不在索引,截断于该点不崩", () => {
    const e1 = msgEntry("a", null, { role: "user", content: "x" });
    const e2 = msgEntry("b", "不存在的父", { role: "user", content: "y" });
    expect(buildBranchPath([e1, e2]).map((e) => e.id)).toEqual(["b"]);
  });

  it("空序列返空路径", () => {
    expect(buildBranchPath([])).toEqual([]);
  });
});

describe("estimateMessageTokens: chars/4 按 role 遍历", () => {
  it("user 文本:8 字符 → 2 token", () => {
    expect(estimateMessageTokens({ role: "user", content: "12345678" })).toBe(2);
  });

  it("assistant:text + thinking + toolCall(name+args JSON)", () => {
    const est = estimateMessageTokens({
      role: "assistant",
      content: [
        { type: "text", text: "1234" },
        { type: "thinking", thinking: "1234" },
        { type: "toolCall", name: "read", args: { p: 1 } },
      ],
    });
    expect(est).toBe(Math.ceil((4 + 4 + "read".length + JSON.stringify({ p: 1 }).length) / 4));
  });

  it("image 块固定 4800 字符 → 1200", () => {
    expect(estimateMessageTokens({ role: "user", content: [{ type: "image" }] })).toBe(1200);
  });

  it("未知 role / 非对象 → 0", () => {
    expect(estimateMessageTokens({ role: "divider", content: "" })).toBe(0);
    expect(estimateMessageTokens(null)).toBe(0);
  });
});

describe("estimateContextTokens: 末条有效 usage 锚定 + 尾随估算", () => {
  it("有锚点:total + 尾随消息估算", () => {
    const anchor = { role: "assistant", stopReason: "stop", usage: { totalTokens: 1000 }, content: [] };
    const trailing = { role: "user", content: "12345678" };
    expect(estimateContextTokens([anchor, trailing])).toBe(1002);
  });

  it("aborted/error 的 usage 不是有效锚点,继续向前找", () => {
    const aborted = { role: "assistant", stopReason: "aborted", usage: { totalTokens: 999 }, content: [] };
    const ok = { role: "assistant", stopReason: "stop", usage: { totalTokens: 500 }, content: [] };
    expect(estimateContextTokens([aborted, ok])).toBe(500);
  });

  it("无任何 usage:纯估算全序列", () => {
    expect(estimateContextTokens([
      { role: "user", content: "12345678" },
      { role: "user", content: "1234" },
    ])).toBe(3);
  });
});

describe("branchContextTokens: compaction 边界 + 诚实未知", () => {
  it("无 compaction:锚点 + 尾随", () => {
    const entries = [
      msgEntry("a", null, { role: "user", content: "问" }),
      assistantWithUsage("b", "a", 1000),
      msgEntry("c", "b", { role: "user", content: "12345678" }),
    ];
    expect(branchContextTokens(entries)).toBe(1002);
  });

  it("compaction 后无有效 usage → null(诚实未知)", () => {
    const entries = [
      assistantWithUsage("a", null, 5000),
      compactionEntry("b", "a"),
      msgEntry("c", "b", { role: "user", content: "压缩后新问题" }),
    ];
    expect(branchContextTokens(entries)).toBeNull();
  });

  it("compaction 后有 usage:锚点取边界后,旧上下文不混入", () => {
    const entries = [
      assistantWithUsage("a", null, 5000),
      compactionEntry("b", "a"),
      msgEntry("c", "b", { role: "user", content: "问" }),
      assistantWithUsage("d", "c", 800),
    ];
    expect(branchContextTokens(entries)).toBe(800);
  });
});

describe("messageUsageOf: total 兜底对齐底座 calculateContextTokens", () => {
  it("totalTokens 缺失 → 四项求和", () => {
    const u = messageUsageOf({ usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
    expect(u?.tokens.total).toBe(10);
  });

  it("totalTokens 为 0 → 四项求和(底座 || 语义)", () => {
    const u = messageUsageOf({ usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 0 } });
    expect(u?.tokens.total).toBe(10);
  });

  it("totalTokens 在场 → 直接取(实测恒等于四项和)", () => {
    const u = messageUsageOf({ usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 99 } });
    expect(u?.tokens.total).toBe(99);
  });
});
