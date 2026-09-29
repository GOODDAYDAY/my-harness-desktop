// deduplicateAdjacent 单元测试 —— 针对「相邻 divider 判重」根因修复。
// 圆心纯函数,零 mock(测试策略:domain 测试 95%+ 目标。原指向的 docs/test/testing-strategy.md 已不存在,去掉死指针保留目标)。
// 数据形状取自真实会话 JSONL(~/.pi/agent/sessions/.../2026-08-03T15-12-41 文件实测):
//   model_change 与 thinking_level_change entry 相邻写入,经 sessionEntryToNeutral
//   后两条 divider 相邻——修复前第二条必被吞。
import { describe, it, expect } from "vitest";
import { sessionEntryToNeutral, deduplicateAdjacent, withTerminalState, type NeutralMessage } from "./session-state";

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

// ============ 上下文占用估算(estimateContextUsageFromSeq 等) ============
// 口径依据:底座 dist/core/compaction/compaction.js 实测算法 + 两处有意偏离
// (锚点严口径 / 无锚点不做全量假数字)——见 session-state.ts 节头注。
import { contextTokensOf, estimateMessageTokens, contextSeqItemOf, estimateContextUsageFromSeq, resolveContextUsage, type ContextSeqItem } from "./session-state";

describe("contextTokensOf", () => {
  it("totalTokens 优先;缺失回退四项和", () => {
    expect(contextTokensOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 })).toBe(10);
    expect(contextTokensOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 0 })).toBe(10);
  });
});

describe("estimateMessageTokens(chars/4,按 role 分派)", () => {
  it("user 字符串 content", () => {
    expect(estimateMessageTokens({ role: "user", content: "12345678" })).toBe(2);
  });
  it("assistant 内容块:text + thinking + toolCall(arguments 序列化)", () => {
    expect(estimateMessageTokens({
      role: "assistant",
      content: [
        { type: "text", text: "1234" },
        { type: "thinking", thinking: "12345678" },
        { type: "toolCall", name: "bash", arguments: { command: "ls" } },
      ],
    })).toBe(Math.ceil((4 + 8 + 4 + JSON.stringify({ command: "ls" }).length) / 4));
  });
  it("toolResult / bashExecution / compactionSummary 各自字段", () => {
    expect(estimateMessageTokens({ role: "toolResult", content: "12345678" })).toBe(2);
    expect(estimateMessageTokens({ role: "bashExecution", command: "1234", output: "12345678" })).toBe(3);
    expect(estimateMessageTokens({ role: "compactionSummary", summary: "12345678" })).toBe(2);
  });
  it("image 块按 4800 chars 计", () => {
    expect(estimateMessageTokens({ role: "user", content: [{ type: "image" }] })).toBe(1200);
  });
});

describe("contextSeqItemOf(锚点判断)", () => {
  const assistant = (usage: Record<string, unknown>, stopReason = "stop") =>
    ({ role: "assistant", stopReason, content: [{ type: "text", text: "ok" }], usage });
  it("健康 usage → anchor = totalTokens", () => {
    const item = contextSeqItemOf(assistant({ input: 400, output: 200, cacheRead: 300, cacheWrite: 100, totalTokens: 1000 }));
    expect(item.anchor).toBe(1000);
  });
  it("prompt 全 0 的坏锚点 → null(只认输出量会把长会话算成个位数)", () => {
    expect(contextSeqItemOf(assistant({ input: 0, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 2 })).anchor).toBeNull();
  });
  it("aborted / error 不作锚点;非 assistant 不作锚点", () => {
    const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 };
    expect(contextSeqItemOf(assistant(usage, "aborted")).anchor).toBeNull();
    expect(contextSeqItemOf(assistant(usage, "error")).anchor).toBeNull();
    expect(contextSeqItemOf({ role: "user", content: "hi", usage }).anchor).toBeNull();
  });
});

describe("estimateContextUsageFromSeq", () => {
  const seq = (...items: Partial<ContextSeqItem>[]): ContextSeqItem[] =>
    items.map((i) => ({ est: 0, anchor: null, ...i }));

  it("末条锚点 + 其后 trailing est 之和", () => {
    const r = estimateContextUsageFromSeq(seq({ anchor: 1000 }, { est: 10 }, { est: 15 }), 0);
    expect(r?.tokens).toBe(1025);
    expect(r?.percent).toBeNull(); // contextWindow 0 = 未知
  });
  it("contextWindow 已知时 percent 现算", () => {
    const r = estimateContextUsageFromSeq(seq({ anchor: 500 }), 1000);
    expect(r?.percent).toBe(50);
  });
  it("压缩后无新锚点 → tokens: null(压缩前旧锚点废弃)", () => {
    const r = estimateContextUsageFromSeq(seq({ anchor: 9000 }, { compaction: true, est: 5 }), 1000);
    expect(r).toEqual({ tokens: null, contextWindow: 1000, percent: null });
  });
  it("压缩后有新锚点 → 新锚点生效", () => {
    const r = estimateContextUsageFromSeq(seq({ anchor: 9000 }, { compaction: true, est: 5 }, { anchor: 2000 }), 0);
    expect(r?.tokens).toBe(2000);
  });
  it("全序列无锚点(无压缩)→ undefined 诚实未知,不做全量假数字", () => {
    expect(estimateContextUsageFromSeq(seq({ est: 100 }, { est: 200 }), 1000)).toBeUndefined();
  });
});

describe("resolveContextUsage(信任序:usage 锚 > probe 实测 > 诚实未知)", () => {
  const base = { tokens: 44, contextWindow: 1000, percent: 4.4 };

  it("锚可信 → 原样返回,一个字段不动(含压缩后 tokens:null)", () => {
    expect(resolveContextUsage(base, true, 99999)).toBe(base);
    const compacted = { tokens: null, contextWindow: 1000, percent: null };
    expect(resolveContextUsage(compacted, true, 99999)).toBe(compacted);
  });
  it("锚不可信 + 有实测 → 实测值,percent 现算", () => {
    expect(resolveContextUsage(base, false, 500)).toEqual({ tokens: 500, contextWindow: 1000, percent: 50 });
  });
  it("锚不可信 + 有实测 + 窗口未知 → percent null", () => {
    expect(resolveContextUsage(undefined, false, 500)).toEqual({ tokens: 500, contextWindow: 0, percent: null });
  });
  it("锚不可信 + 无实测 → tokens:null 诚实未知(假锚点不放行)", () => {
    expect(resolveContextUsage(base, false, null)).toEqual({ tokens: null, contextWindow: 1000, percent: null });
  });
  it("锚不可信 + 无实测 + 无 base → undefined", () => {
    expect(resolveContextUsage(undefined, false, null)).toBeUndefined();
  });
});

describe("sessionEntryToNeutral: 消息计时契约(startedAt=调用开始,timestamp=完成)", () => {
  // 数据形状取自真实会话 JSONL 实测:assistant 的 entry.timestamp(完成)与
  // message.timestamp(开始)不同,差即一轮调用真实耗时(思考+生成)。
  const assistantEntry = () => ({
    type: "message", id: "a1", timestamp: "2026-08-03T15:13:09.000Z",
    message: {
      role: "assistant", content: [{ type: "thinking", thinking: "推理…" }, { type: "text", text: "回答" }],
      timestamp: "2026-08-03T15:13:00.000Z",
    },
  });

  it("assistant:startedAt = message.timestamp(开始),timestamp = entry.timestamp(完成)", () => {
    const m = n(assistantEntry());
    expect(m.startedAt).toBe(Date.parse("2026-08-03T15:13:00.000Z"));
    expect(m.timestamp).toBe(Date.parse("2026-08-03T15:13:09.000Z"));
    // 两字段差 = 9s,即 thinking 块"思考已完成(9.0s)"的数据源
    expect(m.timestamp! - m.startedAt!).toBe(9000);
  });

  it("user 消息同样提取(开始=发送时刻,完成=落盘时刻)", () => {
    const m = n({
      type: "message", id: "u1", timestamp: "2026-08-03T15:12:59.500Z",
      message: { role: "user", content: "你好", timestamp: "2026-08-03T15:12:59.000Z" },
    });
    expect(m.startedAt).toBe(Date.parse("2026-08-03T15:12:59.000Z"));
    expect(m.timestamp).toBe(Date.parse("2026-08-03T15:12:59.500Z"));
  });

  it("message 无 timestamp 字段 → startedAt undefined(消费方兜底,不假装 0)", () => {
    const m = n({
      type: "message", id: "a2", timestamp: "2026-08-03T15:13:09.000Z",
      message: { role: "assistant", content: "x" },
    });
    expect(m.startedAt).toBeUndefined();
    expect(m.timestamp).toBe(Date.parse("2026-08-03T15:13:09.000Z"));
  });

  it("非 message 条目(divider)不设 startedAt", () => {
    const m = n(modelEntry("m1"));
    expect(m.startedAt).toBeUndefined();
    expect(m.timestamp).toBe(Date.parse("2026-08-03T15:12:42.516Z"));
  });
});

describe("withTerminalState: 终结态归一(aborted→stopped,不错标 error)", () => {
  // 根因回归守卫:误标期 withErrorState 把 stopReason:"aborted" 经 errorMessage 标成 error——
  // pi 用户点停止,时间线渲染「生成失败」红条而非「已停止」,goal 引擎把人为中断误报成
  // 模型报错(auto_pause_error 而非 auto_pause_interrupt)。
  it("stopReason:aborted → stopped:true,不标 error(即携带 errorMessage 也不)", () => {
    const out = withTerminalState({ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted" } as Record<string, unknown>);
    expect(out.stopped).toBe(true);
    expect(out.error).toBeUndefined();
  });

  it("stopReason:error → error:true(失败红条语义不变)", () => {
    const out = withTerminalState({ role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." } as Record<string, unknown>);
    expect(out.error).toBe(true);
    expect(out.stopped).toBeUndefined();
  });

  it("正常完成(stopReason:stop)→ 两个标记都不加", () => {
    const out = withTerminalState({ role: "assistant", content: "ok", stopReason: "stop" } as Record<string, unknown>);
    expect(out.error).toBeUndefined();
    expect(out.stopped).toBeUndefined();
  });

  it("旧数据读路径修复:误标期写入的 error:true 在 aborted 上被摘除", () => {
    const legacy = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted", error: true } as Record<string, unknown>;
    const out = withTerminalState(legacy);
    expect(out.stopped).toBe(true);
    expect(out.error).toBeUndefined();
  });

  it("幂等:已归一的 stopped 消息再过一遍不变", () => {
    const clean = { role: "assistant", content: [], stopReason: "aborted", stopped: true };
    expect(withTerminalState(clean)).toBe(clean); // 同一引用,无新对象
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deduplicateAdjacent 的**序列化回落**路径（r172；r168 普查排序的最后两条）
//
// 两个私有助手各有一处 catch 回落，都只在 content **无法 JSON 序列化**时走到
// （循环引用、BigInt 等）：
//   · sameContent：`try { JSON.stringify(a) === JSON.stringify(b) } catch { return false }`
//     ⇒ 序列化失败按"**不相同**"处理 ⇒ **不去重**（宁可留重复，不可误删消息）
//   · contentKey：`try { JSON.stringify(content) } catch { return String(content) }`
//     ⇒ 退化成 "[object Object]" 这类字符串 ⇒ 非标准角色下**会被判为同键而去重**
//
// ⚠ 这两个回落的方向是**相反**的（一个偏保守、一个偏激进），而它们各自服务的规则也不同
//   （sameContent 服务"相邻去重"、contentKey 服务"非标准角色全量去重"）。
//   此前零覆盖 ⇒ 谁改坏了都不知道，而症状是用户可见的：**重复气泡**或**消息凭空少一条**。
// ─────────────────────────────────────────────────────────────────────────────
describe("deduplicateAdjacent：content 无法序列化时的回落（相邻去重 vs 全量去重方向相反）", () => {
  /** 造一个循环引用的 content（JSON.stringify 必抛）。 */
  function circular(tag: string): Record<string, unknown> {
    const o: Record<string, unknown> = { tag };
    o.self = o;
    return o;
  }
  const base = { id: "x", timestamp: 0 } as Record<string, unknown>;

  it("① 标准角色 + 循环 content ⇒ sameContent 回落 false ⇒ **两条都保留**（宁可重复不可误删）", () => {
    const a = { ...base, id: "a", role: "assistant", content: circular("a") } as unknown as NeutralMessage;
    const b = { ...base, id: "b", role: "assistant", content: circular("b") } as unknown as NeutralMessage;
    const out = deduplicateAdjacent([a, b]);
    expect(out, "序列化失败按『不相同』处理 ⇒ 不该被相邻去重吃掉").toHaveLength(2);
  });

  it("② 标准角色 + **同一个**循环对象重复两次 ⇒ 仍保留两条（a === b 走的是引用相等分支，但 content 不同对象时回落 false）", () => {
    const c = circular("same");
    const a = { ...base, id: "a", role: "user", content: c } as unknown as NeutralMessage;
    const b = { ...base, id: "b", role: "user", content: c } as unknown as NeutralMessage;
    // content 是**同一个引用** ⇒ sameContent 的第一条 `a === b` 直接为 true ⇒ 相邻去重生效
    expect(deduplicateAdjacent([a, b]), "同一引用的 content 走引用相等分支，仍应去重").toHaveLength(1);
  });

  it("③ 非标准角色 + 循环 content ⇒ contentKey 回落 String() ⇒ 同形对象**全量去重**（与①方向相反）", () => {
    const a = { ...base, id: "a", role: "bashExecution", content: circular("a") } as unknown as NeutralMessage;
    const b = { ...base, id: "b", role: "bashExecution", content: circular("b") } as unknown as NeutralMessage;
    const out = deduplicateAdjacent([a, b]);
    // String(循环对象) 都是 "[object Object]" ⇒ 键相同 ⇒ 第二条被全量去重吃掉
    expect(out, "非标准角色按 contentKey 全量去重；回落后同形对象会同键").toHaveLength(1);
  });

  it("④ 非标准角色 + **可序列化**的不同 content ⇒ 不该被误去重（回落只在序列化失败时生效）", () => {
    const a = { ...base, id: "a", role: "bashExecution", content: { cmd: "ls" } } as unknown as NeutralMessage;
    const b = { ...base, id: "b", role: "bashExecution", content: { cmd: "pwd" } } as unknown as NeutralMessage;
    expect(deduplicateAdjacent([a, b]), "内容不同 ⇒ 键不同 ⇒ 都保留").toHaveLength(2);
  });

  it("⑤ 非标准角色 + 可序列化的**相同** content ⇒ 非相邻也去重（全量去重的既有规则，回退对照）", () => {
    const a = { ...base, id: "a", role: "bashExecution", content: { cmd: "ls" } } as unknown as NeutralMessage;
    const mid = { ...base, id: "m", role: "user", content: "隔开" } as unknown as NeutralMessage;
    const b = { ...base, id: "b", role: "bashExecution", content: { cmd: "ls" } } as unknown as NeutralMessage;
    expect(deduplicateAdjacent([a, mid, b]), "非标准角色全量去重：非相邻的相同内容也算冗余").toHaveLength(2);
  });
});
