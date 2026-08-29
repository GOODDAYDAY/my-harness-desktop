// applyEvent 单元测试 —— 针对「entryAppended 按身份去重」根因修复。
// renderer 侧 session-store 的事件增量应用纯函数(L1.5 范式)。
// 修复前:非消息条目用 textOf(content) 判重,divider content 恒 "" →
// 任意两条 divider 互判重复,后到的 model/thinking 分隔线被吞。
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  applyEvent, applySnapshot, useSessionStore, initSessionStore,
} from "./session-store";
import { useUiStore } from "./ui-store";
import { sessionEntryToNeutral, type NeutralMessage, type SessionEvent, type SessionModelPrefs } from "@my-harness-desktop/shared";

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
const thinkingEntry = (id: string, parentId: string | null, level = "low") => ({
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

describe("applyEvent → dsh 多步 assistant 追加不覆盖 + toolCallEnd 回填结果(根因修复回归)", () => {
  it("占位(pending)被首条 assistant messageEnd 替换;后续 step 的 messageEnd 追加不覆盖", () => {
    // 发送侧:乐观 user + assistant 占位(pending)
    let msgs: NeutralMessage[] = [
      { id: "u1", role: "user", content: "hi" } as NeutralMessage,
      { id: "placeholder", role: "assistant", content: "", pending: true } as NeutralMessage,
    ];
    msgs = applyEvent(msgs, {
      type: "messageEnd",
      message: { id: "a1", role: "assistant", content: [{ type: "thinking", thinking: "想" }, { type: "toolCall", id: "c1", name: "bash", args: {} }] },
    } as unknown as SessionEvent);
    expect(msgs).toHaveLength(2); // user + step1 assistant(替换占位)
    expect(msgs[1].id).toBe("a1");

    // dsh 一轮内第二个 step 的 assistant/message → 追加,不覆盖 step1 的思考链/工具卡
    msgs = applyEvent(msgs, {
      type: "messageEnd",
      message: { id: "a2", role: "assistant", content: "最终答案" },
    } as unknown as SessionEvent);
    expect(msgs).toHaveLength(3);
    expect(msgs[1].id).toBe("a1");
    expect(msgs[2].id).toBe("a2");
  });

  it("toolCallEnd 按 toolCallId 回填 result 到 assistant 内容块的 toolCall 块", () => {
    let msgs: NeutralMessage[] = [
      { id: "u1", role: "user", content: "hi" } as NeutralMessage,
      { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", args: { command: "ls" } }], pending: false } as NeutralMessage,
    ];
    msgs = applyEvent(msgs, {
      type: "toolCallEnd",
      toolCallId: "c1",
      result: [{ type: "text", text: "out" }],
      isError: false,
    } as unknown as SessionEvent);
    const content = msgs[1].content as Array<Record<string, unknown>>;
    expect(content[0].result).toEqual([{ type: "text", text: "out" }]);
    expect(content[0].isError).toBe(false);
  });

  it("toolCallEnd 找不到匹配 toolCall 块时 no-op(pi 已在内容块里,不重复写)", () => {
    const before: NeutralMessage[] = [
      { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "c9", name: "bash", result: "已有", args: {} }], pending: false } as NeutralMessage,
    ];
    const after = applyEvent(before, { type: "toolCallEnd", toolCallId: "c-missing", result: "x" } as unknown as SessionEvent);
    expect(after).toBe(before);
  });
});

describe("applyEvent → entryAppended: id 水合(文本严格优先 + 位置兜底)", () => {
  it("echo/前缀失配兜底:乐观回显是原文、entry 带 System 前缀——锚到乐观的那条 user 消息", () => {
    let msgs: NeutralMessage[] = [
      { id: "tmp-uuid", role: "user", content: "帮我检查这个文件", __optimistic: true } as unknown as NeutralMessage,
    ];
    msgs = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-xz",
      message: { role: "user", content: "[System] 本次会话已限制可用工具。\n可用工具: read, edit\n请勿使用未在列表中的工具。\n\n帮我检查这个文件" },
    }));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("entry-xz");
  });

  it("文本严格优先不误绑:两条同文本可锚消息,倒序取最近一条(与旧行为一致)", () => {
    let msgs: NeutralMessage[] = [
      { role: "assistant", content: "相同的回答", pending: false } as unknown as NeutralMessage,
      { role: "assistant", content: "相同的回答", pending: false } as unknown as NeutralMessage,
    ];
    msgs = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-dup",
      message: { role: "assistant", content: "相同的回答" },
    }));
    expect(msgs[0].id).toBeUndefined();
    expect(msgs[1].id).toBe("entry-dup");
  });

  it("失配兜底按 FIFO 对齐:两条可锚 user 消息时锚到最早未水合的那条", () => {
    let msgs: NeutralMessage[] = [
      { role: "user", content: "旧提问", __optimistic: true } as unknown as NeutralMessage,
      { role: "user", content: "新提问", __optimistic: true } as unknown as NeutralMessage,
    ];
    msgs = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-oldest",
      message: { role: "user", content: "[System]\n\n文本与两条都不等" },
    }));
    expect(msgs[0].id).toBe("entry-oldest");
    expect(msgs[1].id).toBeUndefined();
  });

  it("水合即转正:第一条消息转正后,后续同 role entry 锚到第二条而非反复改绑第一条", () => {
    let msgs: NeutralMessage[] = [
      { role: "assistant", content: "回答一", pending: false } as unknown as NeutralMessage,
      { role: "assistant", content: "回答二", pending: false } as unknown as NeutralMessage,
    ];
    msgs = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-1",
      message: { role: "assistant", content: "回答一" },
    }));
    msgs = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-2",
      message: { role: "assistant", content: "回答二" },
    }));
    expect(msgs[0].id).toBe("entry-1");
    expect(msgs[1].id).toBe("entry-2");
    // 再来一条失配 entry:不能回改绑 msgs[0](已转正)
    msgs = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-3",
      message: { role: "assistant", content: "与两条都不等" },
    }));
    expect(msgs[0].id).toBe("entry-1");
    expect(msgs[1].id).toBe("entry-2");
  });

  it("流式全链:占位 uuid 消息经流式事件后 id 归零,entryAppended 严格匹配回填权威 id", () => {
    let msgs: NeutralMessage[] = [];
    msgs = applyEvent(msgs, {
      type: "messageStart",
      message: { role: "assistant", content: "" },
    } as unknown as SessionEvent);
    msgs = applyEvent(msgs, {
      type: "messageUpdate",
      message: { role: "assistant", content: "完整回答" },
    } as unknown as SessionEvent);
    msgs = applyEvent(msgs, {
      type: "messageEnd",
      message: { role: "assistant", content: "完整回答" },
    } as unknown as SessionEvent);
    expect(msgs[0].id).toBeUndefined();

    msgs = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-real",
      message: { role: "assistant", content: "完整回答" },
    }));
    expect(msgs[0].id).toBe("entry-real");
  });

  it("无可锚消息(全有权威 id 或 role 不同)→ 原样返回,console.warn 显形一次", () => {
    let msgs: NeutralMessage[] = [
      { id: "official-1", role: "assistant", content: "已有正式 id" } as unknown as NeutralMessage,
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const next = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-orphan",
      message: { role: "user", content: "找不到锚点的 user" },
    }));
    expect(next).toBe(msgs);
    expect(msgs[0].id).toBe("official-1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("找不到可锚定的 user");
    warn.mockRestore();
  });
});

// sendMessage 发送兜底单测 —— 针对「新电脑配置了模型却发不出去」根因修复。
// 故障链:settings.json 无默认模型 + 用户未在下拉框点选(无 pending)+ 新会话 →
// 底座 spawn 后静默回落内置 anthropic 默认模型(无该家 key → 401)。修复:此分支
// 显式对齐 models.json 声明序首项,与 timeline 显示链 models[0] 兜底同源。
describe("sendMessage → 新会话无默认模型兜底(根因修复回归)", () => {
  beforeEach(() => {
    useUiStore.setState({ currentSessionPath: null, currentCwd: "/tmp/proj", sessionModelPending: {} });
    useSessionStore.setState({ snapshot: null, messages: [], lastSendNonce: 0 });
  });

  function mockPi(opts: { settings?: Record<string, unknown>; modelsCfg?: unknown; fallbackError?: string }): { calls: string[]; promptPrefs: (SessionModelPrefs | undefined)[] } {
    const calls: string[] = [];
    const promptPrefs: (SessionModelPrefs | undefined)[] = [];
    // 计算兜底模型(镜像 main 的 getFallbackModel 语义):有默认 → null;否则取声明序首个非空 provider 的首个 model。
    const settings = opts.settings ?? {};
    const hasDefault = typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string";
    const providers = ((opts.modelsCfg ?? {}) as { providers?: Record<string, { models?: { id: string }[] }> }).providers ?? {};
    let fallback: { provider: string; model: string } | null = null;
    if (!hasDefault) {
      for (const [pid, p] of Object.entries(providers)) {
        const first = p.models?.[0];
        if (first) { fallback = { provider: pid, model: first.id }; break; }
      }
    }
    vi.stubGlobal("window", {
      kernel: {
        models: { getFallbackModel: async () => {
          if (opts.fallbackError) throw new Error(opts.fallbackError);
          return fallback;
        } },
        sessions: {
          sync: async () => ({}),
          setContext: async () => {},
          // §atomic-send:renderer 只拼 prefs 一次传给 prompt,不再逐条 setModel/setThinkingLevel。
          prompt: async (_t: string, _i: unknown, _d: unknown, prefs?: SessionModelPrefs) => {
            calls.push("prompt");
            promptPrefs.push(prefs);
          },
          list: async () => [],
          getCapabilities: async () => ({ kernel: "pi", locked: false, piExtension: true, dshExtension: false }),
        },
        kernel: { fitPiExtensionAvailable: async () => true },
      },
    });
    return { calls, promptPrefs };
  }

  const cfgWithModels = {
    providers: {
      p1: { baseUrl: "http://x", models: [{ id: "m1", name: "M1" }] },
      p2: { baseUrl: "http://y", models: [{ id: "m2", name: "M2" }] },
    },
  };

  it("settings 无默认 + models.json 非空:prompt 带 prefs=声明序首项", async () => {
    const { calls, promptPrefs } = mockPi({ settings: {}, modelsCfg: cfgWithModels });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["prompt"]);
    expect(promptPrefs[0]).toEqual({ provider: "p1", modelId: "m1", thinkingLevel: "" });
  });

  it("settings 有默认:prefs 为空(底座 spawn 自读默认)", async () => {
    const { calls, promptPrefs } = mockPi({ settings: { defaultProvider: "dp", defaultModel: "dm" }, modelsCfg: cfgWithModels });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["prompt"]);
    expect(promptPrefs[0]).toBeUndefined();
  });

  it("models.json 为空:prefs 为空(无配置可对齐,底座行为接管)", async () => {
    const { calls, promptPrefs } = mockPi({ settings: {}, modelsCfg: { providers: {} } });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["prompt"]);
    expect(promptPrefs[0]).toBeUndefined();
  });

  it("兜底模型读取失败:中止发送,reason=modelPrefs", async () => {
    const { calls } = mockPi({ settings: {}, modelsCfg: cfgWithModels, fallbackError: "Model not found: p1/m1" });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("modelPrefs");
    expect(res.error).toContain("Model not found");
    expect(calls).toEqual([]); // prompt 未发出
  });

  it("首个 provider 无模型:取下一个 provider 的声明序首项", async () => {
    const { calls, promptPrefs } = mockPi({
      settings: {},
      modelsCfg: { providers: { empty: { models: [] }, p2: { models: [{ id: "m2", name: "M2" }] } } },
    });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["prompt"]);
    expect(promptPrefs[0]).toEqual({ provider: "p2", modelId: "m2", thinkingLevel: "" });
  });
});

// pending 回灌回归 —— 针对「改模型后点表情包发送用的是旧模型」。
// 根因链:onSend 模式下 pickModel 只记内存 pending(按会话 key 暂存),send 时才回灌。
// 表情包/发送按钮都走 sendMessage,故此处只验证 store 层:有 pending 时必须先 setModel
// (透传 kernel)再 prompt,绝不落到「读头对齐/兜底」分支用旧模型。
describe("sendMessage → pending 回灌(改模型后发送用新模型)", () => {
  beforeEach(() => {
    useUiStore.setState({ currentSessionPath: null, currentCwd: "/tmp/proj", sessionModelPending: {} });
    useSessionStore.setState({ snapshot: null, messages: [], lastSendNonce: 0 });
  });

  function mockPi(): { calls: string[]; promptPrefs: (SessionModelPrefs | undefined)[] } {
    const calls: string[] = [];
    const promptPrefs: (SessionModelPrefs | undefined)[] = [];
    vi.stubGlobal("window", {
      kernel: {
        models: { getFallbackModel: async () => null },
        sessions: {
          sync: async () => ({}),
          setContext: async () => {},
          prompt: async (_t: string, _i: unknown, _d: unknown, prefs?: SessionModelPrefs) => {
            calls.push("prompt");
            promptPrefs.push(prefs);
          },
          list: async () => [],
          getCapabilities: async () => ({ kernel: "pi", locked: false, piExtension: true, dshExtension: false }),
        },
        kernel: { fitPiExtensionAvailable: async () => true },
      },
    });
    return { calls, promptPrefs };
  }

  it("有 pending:prefs=pending(含 kernel),一次 prompt 带全参,不落到兜底", async () => {
    const { calls, promptPrefs } = mockPi();
    useUiStore.setState({
      sessionModelPending: { "new:/tmp/proj": { provider: "p1", modelId: "m2", thinkingLevel: "high", kernel: "dsh" } },
    });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["prompt"]);
    expect(promptPrefs[0]).toEqual({ provider: "p1", modelId: "m2", thinkingLevel: "high", kernel: "dsh" });
  });

  // 回归(§kernel-forkless §32 主键迁移):timeline 用 currentNeutralSessionId 写 pending,
  // sendMessage 若仍用 currentSessionPath 读会 miss → 回落到 header/兜底 → 选 dsh 却调度到 pi。
  it("活会话(pending 键=neutralSessionId ≠ sessionPath):仍按 neutralSessionId 读回 pending 并透传 kernel", async () => {
    const { calls, promptPrefs } = mockPi();
    useUiStore.setState({
      currentNeutralSessionId: "ns-abc",
      currentSessionPath: "/tmp/proj/sessions/ns-abc.jsonl",
      sessionModelPending: { "ns-abc": { provider: "p1", modelId: "m2", thinkingLevel: "high", kernel: "dsh" } },
    });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["prompt"]);
    expect(promptPrefs[0]).toEqual({ provider: "p1", modelId: "m2", thinkingLevel: "high", kernel: "dsh" });
  });
});

// 评论真相源回归(设计 docs/design/aux-block-mechanism.md §5)——乐观 content 直接放全文:
// 发送当轮渲染层即能解析出引用条,不依赖落盘回放;水合保留乐观 content,块不丢。
describe("sendMessage → 乐观 content 含块(评论真相源回归)", () => {
  beforeEach(() => {
    useUiStore.setState({ currentSessionPath: null, currentCwd: "/tmp/proj", sessionModelPending: {} });
    useSessionStore.setState({ snapshot: null, messages: [], lastSendNonce: 0 });
  });

  function mockPi(): void {
    vi.stubGlobal("window", {
      kernel: {
        models: { getFallbackModel: async () => null },
        sessions: {
          setModel: async () => {},
          sync: async () => ({}),
          setContext: async () => {},
          prompt: async () => {},
          list: async () => [],
          getCapabilities: async () => ({ kernel: "pi", locked: false, piExtension: true, dshExtension: false }),
        },
        kernel: { fitPiExtensionAvailable: async () => true },
      },
    });
  }

  it("发送带评论的消息:乐观 user content 是全文(正文 + 块),渲染层发送当轮即可解析", async () => {
    mockPi();
    const block = "<pi-review>\n<item seq=\"①\">意见</item>\n</pi-review>";
    await useSessionStore.getState().sendMessage("/tmp/proj", "正文", { sendSuffix: block });
    const msgs = useSessionStore.getState().messages;
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toBe(`正文\n${block}`); // 含块全文(sendText 用 \n 连接)
    expect(user?.__optimistic).toBe(true);
  });

  it("水合(messageStart)保留含块全文:content: x.content 不覆盖乐观正文", () => {
    const full = "正文\n\n<pi-review>\n<item seq=\"①\">意见</item>\n</pi-review>";
    let msgs: NeutralMessage[] = [
      { id: "opt-1", role: "user", content: full, __optimistic: true, __sendText: full } as unknown as NeutralMessage,
    ];
    msgs = applyEvent(msgs, { type: "messageStart", message: { role: "user", content: full } } as unknown as SessionEvent);
    expect(msgs[0].content).toBe(full); // 含块全文保留
    expect(msgs[0].__optimistic).toBe(true);
  });

  it("水合(messageEnd)转正但块不丢:content 仍是全文", () => {
    const full = "正文\n\n<pi-review>\n<item seq=\"①\">意见</item>\n</pi-review>";
    // 真实形态:乐观 user 后有 pending assistant,末条替换分支不命中,走 user 双轨匹配
    let msgs: NeutralMessage[] = [
      { id: "opt-2", role: "user", content: full, __optimistic: true, __sendText: full } as unknown as NeutralMessage,
      { id: "ast-pend", role: "assistant", content: "", pending: true } as unknown as NeutralMessage,
    ];
    msgs = applyEvent(msgs, { type: "messageEnd", message: { role: "user", content: full } } as unknown as SessionEvent);
    expect(msgs[0].content).toBe(full);
    expect(msgs[0].__optimistic).toBe(false);
  });
});

describe("applyEvent → 消息计时(startedAt/timestamp: thinking 时长数据源)", () => {
  const START = Date.parse("2026-08-03T15:13:00.000Z");
  const END = Date.parse("2026-08-03T15:13:09.000Z");

  it("messageStart:底座 message.timestamp(开始)→ startedAt,清 timestamp(完成未知)", () => {
    const msgs = applyEvent([], {
      type: "messageStart",
      message: { id: "a1", role: "assistant", content: "", timestamp: START },
    } as unknown as SessionEvent);
    expect(msgs[0].startedAt).toBe(START);
    expect(msgs[0].timestamp).toBeUndefined(); // 完成时间未知,不假装
    expect(msgs[0].pending).toBe(true);
  });

  it("messageEnd 后 entryAppended 水合:timestamp=完成时间补上,startedAt 保留", () => {
    let msgs: NeutralMessage[] = [];
    msgs = applyEvent(msgs, {
      type: "messageStart",
      message: { role: "assistant", content: "回复", timestamp: START },
    } as unknown as SessionEvent);
    msgs = applyEvent(msgs, {
      type: "messageEnd",
      message: { role: "assistant", content: "回复", timestamp: START },
    } as unknown as SessionEvent);
    expect(msgs[0].pending).toBe(false);
    expect(msgs[0].timestamp).toBeUndefined(); // end 后仍无完成时间

    // 落盘回执(entryAppended)带权威 entry:补 timestamp + startedAt
    msgs = applyEvent(msgs, entryAppended({
      type: "message", id: "entry-a1", timestamp: new Date(END).toISOString(),
      message: { role: "assistant", content: "回复", timestamp: new Date(START).toISOString() },
    }));
    expect(msgs[0].id).toBe("entry-a1");
    expect(msgs[0].startedAt).toBe(START);
    expect(msgs[0].timestamp).toBe(END);
    expect(msgs[0].timestamp! - msgs[0].startedAt!).toBe(9000); // thinking 块显示 9.0s
  });

  it("末条替换分支(messageEnd 无 id):startedAt 仍保留,timestamp 不误设", () => {
    let msgs: NeutralMessage[] = [];
    msgs = applyEvent(msgs, {
      type: "messageStart",
      message: { id: "a1", role: "assistant", content: "", timestamp: START },
    } as unknown as SessionEvent);
    msgs = applyEvent(msgs, {
      type: "messageEnd",
      message: { role: "assistant", content: "回复", timestamp: START },
    } as unknown as SessionEvent);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].startedAt).toBe(START);
    expect(msgs[0].timestamp).toBeUndefined();
  });

  it("messageUpdate 不丢 startedAt(find-by-id patch)", () => {
    let msgs: NeutralMessage[] = [];
    msgs = applyEvent(msgs, {
      type: "messageStart",
      message: { id: "a1", role: "assistant", content: "", timestamp: START },
    } as unknown as SessionEvent);
    msgs = applyEvent(msgs, {
      type: "messageUpdate",
      message: { id: "a1", role: "assistant", content: "流式片段", timestamp: START },
    } as unknown as SessionEvent);
    expect(msgs[0].content).toBe("流式片段");
    expect(msgs[0].startedAt).toBe(START);
    expect(msgs[0].timestamp).toBeUndefined();
  });
});

describe("applyEvent → 消息计时:resync 旧消息不被 messageEnd 清 timestamp", () => {
  const START = Date.parse("2026-08-03T15:13:00.000Z");
  const END = Date.parse("2026-08-03T15:13:09.000Z");

  it("已水合的旧消息(resync)收到 messageEnd(find-by-id):timestamp 保留权威完成时间", () => {
    // resync 基线:消息已有 id + startedAt + timestamp(完成时间)
    const before: NeutralMessage[] = [
      { id: "entry-a1", role: "assistant", content: "回复", startedAt: START, timestamp: END } as unknown as NeutralMessage,
    ];
    const after = applyEvent(before, {
      type: "messageEnd",
      message: { id: "entry-a1", role: "assistant", content: "回复", timestamp: START },
    } as unknown as SessionEvent);
    expect(after[0].timestamp).toBe(END); // 权威完成时间不被覆盖
    expect(after[0].startedAt).toBe(START);
    expect(after[0].pending).toBe(false);
  });
});

describe("applySnapshot → 快照应用(乐观尾巴 + 展示元数据/模型保留)", () => {
  const baseState = () => useSessionStore.getState();

  it("冷开会话首发送:快照有历史内容时,乐观尾巴(user+pending assistant)不被冲掉", () => {
    const s = baseState();
    const state = {
      ...s,
      messages: [
        { role: "user", content: "历史问题", id: "h1" },
        { role: "assistant", content: "历史回答", id: "h2" },
        { role: "user", content: "新问题", id: "opt-1", __optimistic: true },
        { role: "assistant", content: "", id: "opt-2", pending: true },
      ] as NeutralMessage[],
    };
    const snapshot = {
      state: { isStreaming: false } as never,
      messages: [
        { role: "user", content: "历史问题", id: "h1" },
        { role: "assistant", content: "历史回答", id: "h2" },
      ] as NeutralMessage[],
      tree: [], commands: [], leafId: null, entries: [],
    };
    const out = applySnapshot(state as never, snapshot as never);
    expect(out.messages).toHaveLength(4); // 历史 2 + 乐观 2
    expect((out.messages![2] as { __optimistic?: boolean }).__optimistic).toBe(true);
    expect((out.messages![3] as { pending?: boolean }).pending).toBe(true);
  });

  it("__image 与 model 按 id 从旧态合回(快照缺这两字段,全量替换会丢)", () => {
    const s = baseState();
    const state = {
      ...s,
      messages: [
        { role: "user", content: "带图", id: "u1", __image: { src: "/img/a.png" } },
        { role: "assistant", content: "答", id: "a1", model: { provider: "p", modelId: "m", kernel: "pi" } },
      ] as unknown as NeutralMessage[],
    };
    const snapshot = {
      state: { isStreaming: false } as never,
      messages: [
        { role: "user", content: "带图", id: "u1" },
        { role: "assistant", content: "答", id: "a1" },
      ] as NeutralMessage[],
      tree: [], commands: [], leafId: null, entries: [],
    };
    const out = applySnapshot(state as never, snapshot as never);
    expect((out.messages![0] as { __image?: unknown }).__image).toEqual({ src: "/img/a.png" });
    expect((out.messages![1] as { model?: unknown }).model).toEqual({ provider: "p", modelId: "m", kernel: "pi" });
  });

  it("空快照(起进程即 sync,无 user/assistant 内容)不冲掉乐观消息", () => {
    const s = baseState();
    const state = {
      ...s,
      messages: [
        { role: "user", content: "新问题", id: "opt-1", __optimistic: true },
      ] as NeutralMessage[],
    };
    const snapshot = {
      state: { isStreaming: false } as never,
      messages: [] as NeutralMessage[],
      tree: [], commands: [], leafId: null, entries: [],
    };
    const out = applySnapshot(state as never, snapshot as never);
    expect(out.messages).toBeUndefined(); // 不提供 messages → 保留现有乐观消息(部分状态合并)
    expect(out.syncNonce).toBeUndefined(); // 无全量替换,不递增(不提供 syncNonce)
  });
});

describe("sessionEntryToNeutral → assistant 消息投影执行模型", () => {
  it("entry 带 model 字段时,投影进 NeutralMessage.model(发送时固定)", () => {
    const m = sessionEntryToNeutral({
      type: "message",
      id: "e1",
      timestamp: "2026-08-03T15:12:42.516Z",
      model: { provider: "deepseek-official", modelId: "deepseek-v4-pro", kernel: "dsh" },
      message: { role: "assistant", content: "回答" },
    });
    expect(m!.model).toEqual({ provider: "deepseek-official", modelId: "deepseek-v4-pro", kernel: "dsh" });
  });
  it("entry 无 model 字段时,message.model 为 undefined(老消息回退)", () => {
    const m = sessionEntryToNeutral({
      type: "message",
      id: "e2",
      timestamp: "2026-08-03T15:12:42.516Z",
      message: { role: "assistant", content: "回答" },
    });
    expect(m!.model).toBeUndefined();
  });
});
