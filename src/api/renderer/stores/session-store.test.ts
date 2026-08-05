// applyEvent 单元测试 —— 针对「entryAppended 按身份去重」根因修复。
// renderer 侧 session-store 的事件增量应用纯函数(L1.5 范式)。
// 修复前:非消息条目用 textOf(content) 判重,divider content 恒 "" →
// 任意两条 divider 互判重复,后到的 model/thinking 分隔线被吞。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyEvent, useSessionStore } from "./session-store";
import { useUiStore } from "./ui-store";
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

  function mockPi(opts: { settings?: Record<string, unknown>; modelsCfg?: unknown; setModelError?: string }): string[] {
    const calls: string[] = [];
    vi.stubGlobal("window", {
      pi: {
        piSettings: { get: async () => opts.settings ?? {} },
        models: { get: async () => opts.modelsCfg ?? {} },
        sessions: {
          setModel: async (p: string, m: string) => {
            if (opts.setModelError) throw new Error(opts.setModelError);
            calls.push(`setModel:${p}/${m}`);
          },
          sync: async () => ({}),
          setContext: async () => {},
          prompt: async () => { calls.push("prompt"); },
          list: async () => [],
        },
        kernel: { toolgateAvailable: async () => true },
      },
    });
    return calls;
  }

  const cfgWithModels = {
    providers: {
      p1: { baseUrl: "http://x", models: [{ id: "m1", name: "M1" }] },
      p2: { baseUrl: "http://y", models: [{ id: "m2", name: "M2" }] },
    },
  };

  it("settings 无默认 + models.json 非空:先 setModel 声明序首项再 prompt", async () => {
    const calls = mockPi({ settings: {}, modelsCfg: cfgWithModels });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["setModel:p1/m1", "prompt"]);
  });

  it("settings 有默认:不额外 setModel(底座 spawn 自读默认)", async () => {
    const calls = mockPi({ settings: { defaultProvider: "dp", defaultModel: "dm" }, modelsCfg: cfgWithModels });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["prompt"]);
  });

  it("models.json 为空:不对齐直接发(无配置可对齐,底座行为接管)", async () => {
    const calls = mockPi({ settings: {}, modelsCfg: { providers: {} } });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["prompt"]);
  });

  it("首项 setModel 失败:中止发送,reason=modelPrefs(契约同 pending 分支)", async () => {
    const calls = mockPi({ settings: {}, modelsCfg: cfgWithModels, setModelError: "Model not found: p1/m1" });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("modelPrefs");
    expect(res.error).toContain("Model not found");
    expect(calls).toEqual([]); // prompt 未发出
  });

  it("首个 provider 无模型:取下一个 provider 的声明序首项", async () => {
    const calls = mockPi({
      settings: {},
      modelsCfg: { providers: { empty: { models: [] }, p2: { models: [{ id: "m2", name: "M2" }] } } },
    });
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["setModel:p2/m2", "prompt"]);
  });
});
