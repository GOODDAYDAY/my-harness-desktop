// pi 事件翻译单测 —— 钉住「pi 线格式 → 中性契约」的字段归一。
//
// 为什么单立这份(此前 pi 侧只有 context-binding.test.ts,翻译层零覆盖):
// compaction_end 的摘要在 pi 真实事件里嵌在 `result` 下(agent-session.ts 的 CompactionResult),
// 而中性契约 CompactionEndEvent 声明的是**顶层** summary/tokensBefore。翻译层漏了这一步归一时,
// 后果是双层静默的:壳的压缩分隔线没有 detail(seed 投影的「摘要代身」永远走不到、一律全量回灌),
// UI 也没有 token 数。既有单测之所以没抓到:它们手搓**扁平**事件(顶层带 summary),
// 而 `...piEvent` 透传让扁平形状照样能过 —— 测试教的形状 pi 根本不发。
// 本文件一律用 pi 的**真实线格式**做输入。
// 运行时证据锚点:scripts/demo/compaction-rewind.e2e.mjs 的 ⑰⑱。
import { describe, it, expect } from "vitest";
import { translateEvent } from "./event-translator";

describe("translateEvent:compaction_end 的 result.* 平铺成中性契约字段", () => {
  it("真实 pi 形状(result 嵌套)→ 顶层 summary/tokensBefore(契约 CompactionEndEvent)", () => {
    const out = translateEvent({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      result: {
        summary: "聊过天气与架构",
        firstKeptEntryId: "keep-1",
        tokensBefore: 5300,
        estimatedTokensAfter: 800,
        details: { fileOps: [] },
      },
    }) as Record<string, unknown>;
    expect(out.type).toBe("compactionEnd");
    expect(out.summary).toBe("聊过天气与架构");
    expect(out.tokensBefore).toBe(5300);
    expect(out.reason).toBe("manual"); // 原有字段不丢
  });

  it("threshold/overflow 触发同样归一(不只 manual)", () => {
    const out = translateEvent({
      type: "compaction_end", reason: "threshold", aborted: false, willRetry: true,
      result: { summary: "自动压缩摘要", firstKeptEntryId: "k", tokensBefore: 20001 },
    }) as Record<string, unknown>;
    expect(out.summary).toBe("自动压缩摘要");
    expect(out.tokensBefore).toBe(20001);
  });

  it("压缩失败(result: undefined)→ 不伪造摘要/数字(缺省而非空串/0)", () => {
    const out = translateEvent({
      type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false,
    }) as Record<string, unknown>;
    expect(out.type).toBe("compactionEnd");
    expect(out.summary).toBeUndefined();
    expect(out.tokensBefore).toBeUndefined();
    expect(out.aborted).toBe(true);
  });

  it("脏值不透传:summary 非字符串/空白、tokensBefore 非有限数 → 一律缺省", () => {
    const dirty = translateEvent({
      type: "compaction_end",
      result: { summary: "   ", tokensBefore: Number.NaN },
    }) as Record<string, unknown>;
    expect(dirty.summary).toBeUndefined();
    expect(dirty.tokensBefore).toBeUndefined();

    const wrongType = translateEvent({
      type: "compaction_end",
      result: { summary: 42, tokensBefore: "5300" },
    }) as Record<string, unknown>;
    expect(wrongType.summary).toBeUndefined();
    expect(wrongType.tokensBefore).toBeUndefined();
  });

  it("result 不是对象(内核形状漂移)→ 不抛、缺省降级", () => {
    for (const result of [null, "oops", 7, []]) {
      const out = translateEvent({ type: "compaction_end", result }) as Record<string, unknown>;
      expect(out.type).toBe("compactionEnd");
      expect(out.summary).toBeUndefined();
    }
  });

  it("compaction_start 原样映射(摘要不在 start 上)", () => {
    const out = translateEvent({ type: "compaction_start", reason: "threshold" }) as Record<string, unknown>;
    expect(out).toMatchObject({ type: "compactionStart", reason: "threshold" });
  });
});

// ==============================================================================================
// 成败判定 compacted:「假边界」的根因守卫。
//
// pi 在**取消与失败**时同样发 compaction_end,只是 result: undefined。此前翻译层不判成败,
// 壳无条件落压缩分隔线 → 中间层出现边界而底层内核 compaction 条目为 0(实测:真实 502 撞上
// 生成摘要的那次模型调用)。假边界会遮蔽更早的真摘要(assembleSeedProjection 找到最新边界就
// break)并让 UI 谎报「上下文已压缩」。
// 判据只有一条:**有 result 对象才算真的压了**(契约三态见 CompactionEndEvent.compacted)。
// ==============================================================================================
describe("translateEvent:compaction_end 的成败判定(compacted)", () => {
  it("成功(带 result 对象)→ compacted: true", () => {
    const out = translateEvent({
      type: "compaction_end", reason: "manual", aborted: false, willRetry: false,
      result: { summary: "摘要", firstKeptEntryId: "k", tokensBefore: 100 },
    }) as Record<string, unknown>;
    expect(out.compacted).toBe(true);
    expect(out.summary).toBe("摘要");
  });

  it("失败(摘要那次模型调用抛错)→ compacted: false + errorMessage 原样带出", () => {
    const out = translateEvent({
      type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false,
      errorMessage: "Auto-compaction failed: 502 provider_connection_failed",
    }) as Record<string, unknown>;
    expect(out.compacted).toBe(false);
    expect(out.errorMessage).toBe("Auto-compaction failed: 502 provider_connection_failed");
    expect(out.summary).toBeUndefined();
  });

  it("溢出恢复第二次仍失败 → compacted: false(pi 的 willRetry:false + errorMessage 形态)", () => {
    const out = translateEvent({
      type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: false,
      errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
    }) as Record<string, unknown>;
    expect(out.compacted).toBe(false);
    expect(out.reason).toBe("overflow");
  });

  it("取消(扩展 cancel / signal aborted)→ compacted: false + aborted: true(取消不是错误,不该报错)", () => {
    const out = translateEvent({
      type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false,
    }) as Record<string, unknown>;
    expect(out.compacted).toBe(false);
    expect(out.aborted).toBe(true);
    expect(out.errorMessage).toBeUndefined(); // 取消没有错误消息,UI 据此不打扰用户
  });

  it("形状漂移(result 是字符串/数字/数组)→ compacted: false(宁判失败,不产无摘要的假边界)", () => {
    // ⚠ 判据必须是「对象」而不只是 != null:result: "oops" 这类漂移值若判成成功,
    //   下游拿不到摘要,又落回「有边界无摘要」的假边界形态(与失败同害)。
    for (const result of ["oops", 7, [], true]) {
      const out = translateEvent({ type: "compaction_end", result }) as Record<string, unknown>;
      expect(out.compacted, `result=${JSON.stringify(result)} 不该被判成压缩成功`).toBe(false);
    }
  });

  it("errorMessage 是空串/非字符串 → 不带(UI 不该弹一条空提示)", () => {
    for (const errorMessage of ["", "   ", 42, null]) {
      const out = translateEvent({ type: "compaction_end", result: undefined, errorMessage }) as Record<string, unknown>;
      expect(out.errorMessage).toBeUndefined();
      expect(out.compacted).toBe(false);
    }
  });
});

describe("translateEvent:其余映射不回潮(归一新增分支不得打断既有翻译)", () => {
  it("type 映射表照旧", () => {
    expect(translateEvent({ type: "agent_settled" }).type).toBe("agentSettled");
    expect(translateEvent({ type: "tool_execution_end" }).type).toBe("toolCallEnd");
    expect(translateEvent({ type: "queue_update", pendingMessageCount: 2 })).toMatchObject({
      type: "queueUpdate", pendingMessageCount: 2,
    });
  });

  it("session_info_changed 的 name → sessionName(与 compaction 同类的字段归一先例)", () => {
    expect(translateEvent({ type: "session_info_changed", name: "新名字" })).toMatchObject({
      type: "sessionInfoChanged", sessionName: "新名字",
    });
  });

  it("未识别 type 原样透传(兜底不回潮)", () => {
    expect(translateEvent({ type: "future_event", x: 1 })).toMatchObject({ type: "future_event", x: 1 });
  });
});
