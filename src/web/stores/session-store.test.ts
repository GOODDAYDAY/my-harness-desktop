// 渲染层会话 store 单测 —— 会话单源(session-single-source)后的新语义:
// 内容真相源 = 中立层镜像(neutral-mirror);事件只驱动执行态叠加层(applyOverlayEvent);
// 合并视图 = mergeMirrorWithOverlay(镜像内容 + 叠加层)。
// 旧 applyEvent 的内容拼装/id 水合/文本相亲全部退役——锚点身份由中立 entryId 结构保证。
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  applyOverlayEvent, mergeMirrorWithOverlay, applySnapshot, useSessionStore, initSessionStore, hydrateSessionStart, refreshThinkingLevels, getInflightToolCalls,
} from "./session-store";
import { useUiStore } from "./ui-store";
// 会话级待执行意图已迁到会话作用域容器(设计 docs/design/session-scope.md §2.6):
// 断言对象从 ui-store 的 Record 字段改成派生层读写函数,**断言口径不变**——
// 隔离/搬迁/清账三条语义在迁移前后必须一致(设计 §3.1.2 把本文件列为批 2 的行为门)。
import {
  readModelPending, writeModelPending, readComposerDraft, writeComposerDraft,
  readPendingQueue, enqueueMessage,
} from "./session-pending";
import { __resetScopesForTests } from "./session-scope";
import { sessionEntryToNeutral, type NeutralMessage, type SessionEvent, type SessionModelPrefs } from "@my-harness-desktop/shared";

function n(entry: Record<string, unknown>): NeutralMessage {
  const m = sessionEntryToNeutral(entry);
  if (!m) throw new Error("fixture entry 应映射为非空消息");
  return m;
}

const user = (content: string, extra?: Partial<NeutralMessage>): NeutralMessage =>
  ({ role: "user", content, ...extra }) as NeutralMessage;
const asst = (content: unknown, extra?: Partial<NeutralMessage>): NeutralMessage =>
  ({ role: "assistant", content, ...extra }) as NeutralMessage;

describe("hydrateSessionStart → 中立主键水合(fork/bookmark 入口的命脉)", () => {
  beforeEach(() => {
    useUiStore.setState({ currentSessionPath: null, currentNeutralSessionId: null });
    useSessionStore.setState({ sessionInfos: null });
  });

  it("事件携带 neutralSessionId:直接用,不查 sessionInfos(新会话列表未含时不再落空)", () => {
    hydrateSessionStart({
      type: "sessionStart",
      sessionFile: "/tmp/agent/sessions/bucket/ns-new.jsonl",
      neutralSessionId: "ns-new",
    } as unknown as SessionEvent);
    expect(useUiStore.getState().currentSessionPath).toBe("/tmp/agent/sessions/bucket/ns-new.jsonl");
    expect(useUiStore.getState().currentNeutralSessionId).toBe("ns-new");
  });

  it("事件缺 neutralSessionId(旧 main):回落 sessionInfos 反查", () => {
    useSessionStore.setState({
      sessionInfos: { "/tmp/agent/sessions/bucket/ns-old.jsonl": { neutralSessionId: "ns-old" } as never },
    });
    hydrateSessionStart({ type: "sessionStart", sessionFile: "/tmp/agent/sessions/bucket/ns-old.jsonl" } as unknown as SessionEvent);
    expect(useUiStore.getState().currentNeutralSessionId).toBe("ns-old");
  });

  it("既无事件值又查不到:置 null(诚实),不留旧会话残留", () => {
    useUiStore.setState({ currentNeutralSessionId: "ns-prev" });
    hydrateSessionStart({ type: "sessionStart", sessionFile: "/tmp/x.jsonl" } as unknown as SessionEvent);
    expect(useUiStore.getState().currentNeutralSessionId).toBeNull();
  });

  it("无 sessionFile:不动现有状态", () => {
    useUiStore.setState({ currentSessionPath: "/tmp/keep.jsonl", currentNeutralSessionId: "ns-keep" });
    hydrateSessionStart({ type: "sessionStart" } as unknown as SessionEvent);
    expect(useUiStore.getState().currentSessionPath).toBe("/tmp/keep.jsonl");
    expect(useUiStore.getState().currentNeutralSessionId).toBe("ns-keep");
  });
});

describe("startNewChat → 清空中立主键 + 叠加层(防止新会话锚到旧会话树)", () => {
  it("currentNeutralSessionId 随新会话清空,messages/overlay 清空", async () => {
    vi.stubGlobal("window", {
      kernel: {
        sessions: {
          setContext: async () => {},
          getCapabilities: async () => ({ kernel: "pi", locked: false, extension: true, thinking: false }),
        },
      },
    });
    useUiStore.setState({ currentNeutralSessionId: "ns-prev", currentSessionPath: "/tmp/prev.jsonl" });
    useSessionStore.setState({ messages: [user("残留")], overlay: [user("残留")] });
    await useSessionStore.getState().startNewChat("/tmp/proj");
    expect(useUiStore.getState().currentNeutralSessionId).toBeNull();
    expect(useSessionStore.getState().messages).toHaveLength(0);
    expect(useSessionStore.getState().overlay).toHaveLength(0);
  });
});

describe("applyOverlayEvent → 流式占位生命周期(执行态只管视觉)", () => {
  const START = Date.parse("2026-08-03T15:13:00.000Z");

  it("messageStart 挂 pending 占位(timestamp→startedAt,完成时间清掉)", () => {
    const ov = applyOverlayEvent([], {
      type: "messageStart",
      message: { id: "a1", role: "assistant", content: "", timestamp: START },
    } as unknown as SessionEvent);
    expect(ov).toHaveLength(1);
    expect(ov[0].pending).toBe(true);
    expect(ov[0].startedAt).toBe(START);
    expect(ov[0].timestamp).toBeUndefined(); // 完成时间未知,不假装
  });

  it("messageUpdate patch 占位内容,pending 不丢、startedAt 不前移", () => {
    let ov = applyOverlayEvent([], {
      type: "messageStart",
      message: { id: "a1", role: "assistant", content: "", timestamp: START },
    } as unknown as SessionEvent);
    ov = applyOverlayEvent(ov, {
      type: "messageUpdate",
      message: { id: "a1", role: "assistant", content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "片段" }] },
    } as unknown as SessionEvent);
    expect(ov).toHaveLength(1);
    expect(ov[0].pending).toBe(true);
    expect(ov[0].startedAt).toBe(START);
    expect((ov[0].content as unknown[]).length).toBe(2);
  });

  it("messageEnd 摘除占位(定稿内容已由主侧写穿落中立层,回执先于本事件到达)", () => {
    let ov = applyOverlayEvent([], {
      type: "messageStart", message: { role: "assistant", content: "" },
    } as unknown as SessionEvent);
    ov = applyOverlayEvent(ov, {
      type: "messageEnd", message: { role: "assistant", content: "答" },
    } as unknown as SessionEvent);
    expect(ov).toHaveLength(0); // 占位摘除,内容归镜像
  });

  it("搁浅防线:旧占位没摘时,新 messageStart 先摘旧再挂新(永不留两条 pending)", () => {
    let ov = applyOverlayEvent([], { type: "messageStart", message: { id: "s1", role: "assistant", content: "想" } } as unknown as SessionEvent);
    ov = applyOverlayEvent(ov, { type: "messageStart", message: { id: "s2", role: "assistant", content: "再想" } } as unknown as SessionEvent);
    expect(ov.filter((m) => m.pending === true)).toHaveLength(1);
    expect(ov[0].id).toBe("s2");
  });

  it("toolCallStart/End 登登记表,running→done", () => {
    let ov = applyOverlayEvent([], { type: "messageStart", message: { id: "s1", role: "assistant", content: [] } } as unknown as SessionEvent);
    ov = applyOverlayEvent(ov, { type: "toolCallStart", toolCallId: "c1", toolName: "bash" } as unknown as SessionEvent);
    ov = applyOverlayEvent(ov, { type: "toolCallEnd", toolCallId: "c1", result: "out", isError: false } as unknown as SessionEvent);
    // 登记表经 mergeMirrorWithOverlay 合并进内容块(见下方合并视图测试)
    expect(ov).toHaveLength(1);
  });
});

// 跨会话工具态隔离(设计 docs/design/session-scope.md §1.1.3 后果一/§5.2 守卫)。
// 根因:toolResultLedger/inflightToolCalls 此前是模块级单例、全仓无 .clear(),切会话清了
// overlay 却没清这两个登记表。两会话撞同一 toolCallId(pi/dsh 各自生成 id、bashExecution
// 还有合成块,撞 id 概率非零)时,B 会话的工具卡会显示 A 的工具结果或永远转圈。
// 迁入会话作用域槽后:每会话各一份,撞 id 也不串。本守卫直接复现该 bug 场景。
describe("工具在飞态按会话隔离(撞 id 不串——§1.1.3 后果一的回归守卫)", () => {
  beforeEach(() => {
    __resetScopesForTests();
    useUiStore.setState({ currentNeutralSessionId: "ns-A", currentCwd: "/proj" });
  });

  it("A 会话的在飞 toolCallId 不出现在 B 会话(即使撞同一 id)", () => {
    // A 会话:bash 工具开始执行,登进 A 域的在飞集
    applyOverlayEvent([], { type: "toolCallStart", toolCallId: "c1", toolName: "bash" } as unknown as SessionEvent);
    expect(getInflightToolCalls().has("c1")).toBe(true);

    // 切到 B:B 域是独立的空集,撞同一 id 也读不到 A 的在飞态
    useUiStore.setState({ currentNeutralSessionId: "ns-B" });
    expect(getInflightToolCalls().has("c1")).toBe(false);

    // 切回 A:A 域原样保留(在飞态按会话隔离,不是切走即清)
    useUiStore.setState({ currentNeutralSessionId: "ns-A" });
    expect(getInflightToolCalls().has("c1")).toBe(true);
  });

  it("toolCallEnd 只清当前会话的在飞态,不影响别的会话同名 id", () => {
    applyOverlayEvent([], { type: "toolCallStart", toolCallId: "c1" } as unknown as SessionEvent);
    useUiStore.setState({ currentNeutralSessionId: "ns-B" });
    applyOverlayEvent([], { type: "toolCallStart", toolCallId: "c1" } as unknown as SessionEvent);
    // B 结束 c1
    applyOverlayEvent([], { type: "toolCallEnd", toolCallId: "c1", result: "B 的输出" } as unknown as SessionEvent);
    expect(getInflightToolCalls().has("c1")).toBe(false);   // B 域 c1 已结束
    // A 域的 c1 仍在飞(B 的结束不串到 A)
    useUiStore.setState({ currentNeutralSessionId: "ns-A" });
    expect(getInflightToolCalls().has("c1")).toBe(true);
  });
});

describe("mergeMirrorWithOverlay → 合并视图(镜像内容 + 执行态叠加)", () => {
  it("镜像内容在前,叠加层在后", () => {
    const base = [user("问"), asst("答")];
    const overlay = [asst("", { pending: true, id: "s1" })];
    const out = mergeMirrorWithOverlay(base, overlay);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(out[2].pending).toBe(true);
  });

  it("乐观 user 气泡:镜像里已出现同文条目 → 从叠加层摘除(转正不双条)", () => {
    const base = [user("你好")];
    const overlay = [user("你好", { __optimistic: true }), asst("", { pending: true })];
    const out = mergeMirrorWithOverlay(base, overlay);
    expect(out).toHaveLength(2); // base user + pending assistant;乐观气泡摘掉
    expect(out.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("乐观 user 气泡:镜像未覆盖(不同文) → 保留", () => {
    const base = [user("旧问")];
    const overlay = [user("新问", { __optimistic: true })];
    const out = mergeMirrorWithOverlay(base, overlay);
    expect(out.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("工具结果登记表:按 toolCallId 补到镜像内容块(定稿时结果未落的补上)", () => {
    const base = [asst([{ type: "toolCall", id: "c1", name: "bash", args: { command: "ls" } }])];
    const ledger = new Map([["c1", { result: "out", isError: false, state: "done" }]]);
    const out = mergeMirrorWithOverlay(base, [], ledger);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content[0].result).toBe("out");
    expect(content[0].state).toBe("done");
  });

  it("工具结果登记表:已定稿带结果的块不覆盖(内容块权威优先)", () => {
    const base = [asst([{ type: "toolCall", id: "c1", name: "bash", result: "已有" }])];
    const ledger = new Map([["c1", { result: "新", state: "done" }]]);
    const out = mergeMirrorWithOverlay(base, [], ledger);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content[0].result).toBe("已有");
  });
});

// sendMessage 发送兜底单测 —— 针对「新电脑配置了模型却发不出去」根因修复。
// 故障链:settings.json 无默认模型 + 用户未在下拉框点选(无 pending)+ 新会话 →
// 底座 spawn 后静默回落内置 anthropic 默认模型(无该家 key → 401)。修复:此分支
// 显式对齐 models.json 声明序首项,与 timeline 显示链 models[0] 兜底同源。
describe("sendMessage → 新会话无默认模型兜底(根因修复回归)", () => {
  beforeEach(() => {
    useUiStore.setState({ currentSessionPath: null, currentCwd: "/tmp/proj" });
    useSessionStore.setState({ snapshot: null, messages: [], overlay: [], lastSendNonce: 0 });
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
          getCapabilities: async () => ({ kernel: "pi", locked: false, extension: true, thinking: false }),
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
    useUiStore.setState({ currentSessionPath: null, currentCwd: "/tmp/proj" });
    useSessionStore.setState({ snapshot: null, messages: [], overlay: [], lastSendNonce: 0 });
  });

  function mockPi(): { calls: string[]; promptPrefs: (SessionModelPrefs | undefined)[] } {
    const calls: string[] = [];
    const promptPrefs: (SessionModelPrefs | undefined)[] = [];
    vi.stubGlobal("window", {
      kernel: {
        models: { getFallbackModel: async () => null },
        sessions: {
          sync: async () => {},
          setContext: async () => {},
          prompt: async (_t: string, _i: unknown, _d: unknown, prefs?: SessionModelPrefs) => {
            calls.push("prompt");
            promptPrefs.push(prefs);
          },
          list: async () => [],
          getCapabilities: async () => ({ kernel: "pi", locked: false, extension: true, thinking: false }),
        },
        kernel: { fitPiExtensionAvailable: async () => true },
      },
    });
    return { calls, promptPrefs };
  }

  it("有 pending:prefs=pending(含 kernel),一次 prompt 带全参,不落到兜底", async () => {
    const { calls, promptPrefs } = mockPi();
    // 新会话壳期间点选的模型:挂在壳键作用域上(身份算法由圆心 sessionScopeKey 单源给出)
    writeModelPending({ provider: "p1", modelId: "m2", thinkingLevel: "high", kernel: "dsh" }, "new:/tmp/proj");
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
    });
    writeModelPending({ provider: "p1", modelId: "m2", thinkingLevel: "high", kernel: "dsh" }, "ns-abc");
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "hello");
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["prompt"]);
    expect(promptPrefs[0]).toEqual({ provider: "p1", modelId: "m2", thinkingLevel: "high", kernel: "dsh" });
  });
});

// 会话键漂移回归(用户症状:「发送之后输入框的模型没固定」)。
//
// 链路:新会话壳期间用户点选的模型挂在 `new:${cwd}` 下;首条消息让 ensureForSend **先**
// 派发合成 sessionStart、**后** spawn(application/sessions/session-store.ts 的 dispatch 早于
// start),renderer 的 hydrateSessionStart 随即把 currentNeutralSessionId 从 null 翻成真实 ns。
// 而所有读取侧一律用「currentNeutralSessionId ?? `new:${cwd}`」—— 翻键瞬间旧键再没人读,
// 刚点选的那份 pending 变成孤儿,输入框在整个 spawn+首轮窗口里回落到应用默认模型。
// 修法:翻键那一刻把旧键上的按会话暂存态整体搬到新键。搬迁的实现已从 ui-store.carrySessionKey
// (硬编码三个字段名)换成会话作用域容器的 carry(遍历注册表按各槽策略搬)——
// 加第 N 张按会话的表,机制层零改动(设计 docs/design/session-scope.md §2.3.2/§3.1.2)。
describe("sessionStart 翻键时按会话暂存的框架态必须跟着走", () => {
  beforeEach(() => {
    // hydrateSessionStart 会连带写"该项目上次看的会话"(rememberSessionForCwd → prefs.set),
    // 需要最小 kernel 桥;只补这条路径用到的方法,不造整套 mock。
    // 走 globalThis 显式建命名空间,不假设 window 已存在——本文件跑在 node 环境
    // (无 jsdom docblock),`-t` 过滤运行时与整文件运行时对 window 的存在性并不一致。
    const g = globalThis as unknown as { window?: { kernel?: unknown } };
    g.window = g.window ?? {};
    g.window.kernel = { prefs: { set: () => Promise.resolve(), get: () => Promise.resolve(undefined) } };
    useUiStore.setState({
      currentCwd: "/tmp/proj",
      currentNeutralSessionId: null,
      currentSessionPath: null,
      lastSessionByCwd: {},
    });
    __resetScopesForTests();   // 作用域容器清空(身份解析器由 ui-store 模块级绑定,无需重设)
  });

  const startEvent = (ns: string) => ({ type: "sessionStart", sessionFile: `/tmp/proj/sessions/${ns}.jsonl`, neutralSessionId: ns }) as never;

  it("模型点选从 new:${cwd} 改挂到真实 ns(否则输入框回落默认模型)", () => {
    writeModelPending({ provider: "p1", modelId: "m2", thinkingLevel: "high", kernel: "dsh" }, "new:/tmp/proj");
    hydrateSessionStart(startEvent("ns-real"));
    expect(readModelPending("ns-real")).toEqual({ provider: "p1", modelId: "m2", thinkingLevel: "high", kernel: "dsh" });
    expect(readModelPending("new:/tmp/proj")).toBeUndefined(); // 旧键域已摘除(残留会在下次新建时串味)
  });

  it("草稿与排队消息同步跟着走(全部按会话暂存的槽一起搬,不是只搬模型那个)", () => {
    writeComposerDraft("写了一半", "new:/tmp/proj");
    enqueueMessage("排队的一条", undefined, undefined, "new:/tmp/proj");
    hydrateSessionStart(startEvent("ns-real"));
    expect(readComposerDraft("ns-real")).toBe("写了一半");
    expect(readPendingQueue("ns-real").map((q) => q.text)).toEqual(["排队的一条"]);
    // 壳键域整体摘除:草稿读回空、队列读回空
    expect(readComposerDraft("new:/tmp/proj")).toBe("");
    expect(readPendingQueue("new:/tmp/proj")).toEqual([]);
  });

  it("已有 ns 的会话再来 sessionStart(同键/回退)不搬、不覆盖目标键已有值", () => {
    useUiStore.setState({ currentNeutralSessionId: "ns-real" });
    writeModelPending({ provider: "a", modelId: "a", thinkingLevel: "", kernel: "pi" }, "ns-real");
    writeModelPending({ provider: "b", modelId: "b", thinkingLevel: "", kernel: "dsh" }, "new:/tmp/proj");
    hydrateSessionStart(startEvent("ns-real"));
    expect(readModelPending("ns-real")).toEqual({ provider: "a", modelId: "a", thinkingLevel: "", kernel: "pi" }); // 目标键已有值 → 不被覆盖(move 策略)
    expect(readModelPending("new:/tmp/proj")).toEqual({ provider: "b", modelId: "b", thinkingLevel: "", kernel: "dsh" }); // 非 null→ns 翻键,不触发搬迁
  });
});

// 评论真相源回归(设计 docs/design/aux-block-mechanism.md §5)——乐观 content 直接放全文:
// 发送当轮渲染层即能解析出引用条,不依赖落盘回放;镜像覆盖后 content 仍是全文(不丢块)。
describe("sendMessage → 乐观 content 含块(评论真相源回归)", () => {
  beforeEach(() => {
    useUiStore.setState({ currentSessionPath: null, currentCwd: "/tmp/proj" });
    useSessionStore.setState({ snapshot: null, messages: [], overlay: [], lastSendNonce: 0 });
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
          getCapabilities: async () => ({ kernel: "pi", locked: false, extension: true, thinking: false }),
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
    const u = msgs.find((m) => m.role === "user");
    expect(u?.content).toBe(`正文\n${block}`); // 含块全文(sendText 用 \n 连接)
    expect(u?.__optimistic).toBe(true);
  });

  it("镜像覆盖后乐观条目不双条、全文不丢(合并视图按同文转正)", async () => {
    mockPi();
    const full = "正文\n\n<pi-review>\n<item seq=\"①\">意见</item>\n</pi-review>";
    await useSessionStore.getState().sendMessage("/tmp/proj", "正文", { sendSuffix: full.split("\n").slice(2).join("\n") });
    // 镜像覆盖:中立层已含同文 user 条目 → 合并视图里乐观气泡摘掉,只留镜像那条
    const out = mergeMirrorWithOverlay([user(`正文\n${full.split("\n").slice(2).join("\n")}`)], useSessionStore.getState().overlay);
    expect(out.filter((m) => m.role === "user")).toHaveLength(1);
    expect(out[0].content).toBe(`正文\n${full.split("\n").slice(2).join("\n")}`);
  });
});

describe("applySnapshot → 快照只动状态面(内容归中立层镜像,§3.3)", () => {
  const baseState = () => useSessionStore.getState();

  it("快照到达:state/streaming 更新,messages 不动(不再是内容载体)", () => {
    const s = baseState();
    const state = {
      ...s,
      messages: [user("历史问题", { id: "h1" })],
    };
    const snapshot = {
      state: { isStreaming: true } as never,
      messages: [] as NeutralMessage[], // 内容字段即使在也不被消费
      tree: [], commands: [], leafId: null, entries: [],
    };
    const out = applySnapshot(state as never, snapshot as never);
    expect(out.messages).toBeUndefined(); // 不提供 messages → 内容不动
    expect(out.streaming).toBe(true);
    expect(out.ready).toBe(true);
  });

  it("dsh 形态空基线:不伪造内容,状态面照常落", () => {
    const s = baseState();
    const out = applySnapshot({ ...s, messages: [user("在")] } as never, {
      state: { isStreaming: false } as never,
      messages: [], tree: [], commands: [], leafId: null, entries: [],
    } as never);
    expect(out.messages).toBeUndefined();
    expect(out.streaming).toBe(false);
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

describe("sendMessage → 新会话草稿清账(「enter 后要清理」根因回归)", () => {
  beforeEach(() => {
    useUiStore.setState({ currentSessionPath: null, currentCwd: "/tmp/proj" });
    useSessionStore.setState({ snapshot: null, messages: [], overlay: [], lastSendNonce: 0 });
    __resetScopesForTests();
  });

  it("发送成功:new:<cwd> 键下的草稿残留被清(物化晚于发送完成是常态,不再复活已发文本)", async () => {
    vi.stubGlobal("window", {
      kernel: {
        models: { getFallbackModel: async () => null },
        sessions: {
          sync: async () => ({}),
          setContext: async () => {},
          prompt: async () => {},
          list: async () => [],
          getCapabilities: async () => ({ kernel: "pi", locked: false, extension: true, thinking: false }),
        },
        kernel: { fitPiExtensionAvailable: async () => true },
      },
    });
    // 模拟物化竞态的产物:发送完成时 new: 键下仍有文本(键变更瞬间 hook 存回的)
    writeComposerDraft("已发送的正文", "new:/tmp/proj");
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "已发送的正文");
    expect(res.ok).toBe(true);
    expect(readComposerDraft("new:/tmp/proj")).toBe("");
  });

  it("发送失败:new: 键草稿保留(用户文本不丢,可改可重发)", async () => {
    vi.stubGlobal("window", {
      kernel: {
        models: { getFallbackModel: async () => { throw new Error("no model"); } },
        sessions: {
          sync: async () => ({}),
          setContext: async () => {},
          prompt: async () => {},
          list: async () => [],
          getCapabilities: async () => ({ kernel: "pi", locked: false, extension: true, thinking: false }),
        },
      },
    });
    writeComposerDraft("别丢", "new:/tmp/proj");
    const res = await useSessionStore.getState().sendMessage("/tmp/proj", "别丢");
    expect(res.ok).toBe(false);
    expect(readComposerDraft("new:/tmp/proj")).toBe("别丢");
  });
});

// ── 切项目:记忆 + 恢复(根因守卫) ─────────────────────────────────────────
// 根因实弹:projects 的 switchCwd 无条件 startNewChat + 清空上下文 → "切走再切回,上次看的
// 会话没了,永远是个新会话"。修法=壳侧记"每个项目上次看的会话(prefs.lastSessionByCwd)",
// 切项目/冷启动经 restoreForCwd 恢复。这一组断言把四条语义钉住:
//   ① 无记忆 → 新会话壳(与旧行为一致);② 有记忆且可打开 → 恢复;③ 记忆失效(文件删了)→ 退新会话;
//   ④ 写入时机是"打开/物化真实会话",startNewChat 的 null 不许覆盖记忆(否则冷启动那一次就清空)。
describe("切项目:记忆上次会话 + 恢复(不再无条件新会话)", () => {
  let opened: string[] = [];
  let prefsWrites: { key: string; value: unknown }[] = [];
  let detailFor: (id: string) => unknown = () => null;

  const detail = (cwd: string, ns: string, path: string): unknown => ({
    info: { cwd, id: ns, neutralSessionId: ns, path, created: "2026-01-01T00:00:00.000Z" },
    messages: [],
    stats: null,
  });

  beforeEach(() => {
    opened = [];
    prefsWrites = [];
    detailFor = () => null;
    vi.stubGlobal("window", {
      kernel: {
        prefs: {
          get: async () => undefined,
          set: async (key: string, value: unknown) => { prefsWrites.push({ key, value }); },
        },
        configFile: { get: async () => ({}), getLayered: async () => null },
        sessions: {
          setContext: async () => {},
          getStats: async () => null,
          getCapabilities: async () => ({ kernel: "pi", locked: false, extension: true, thinking: false }),
          openSession: async (id: string) => { opened.push(id); return detailFor(id); },
        },
      },
    });
    useUiStore.setState({
      currentCwd: "/proj/a",
      lastSessionByCwd: {},
      currentSessionPath: null,
      currentNeutralSessionId: null,
      sessionTitle: null,
    });
    useSessionStore.setState({ messages: [], overlay: [], stats: null, snapshot: null, sessionInfos: null });
  });

  it("无记忆(首次访问该项目):切过去起新会话壳,与旧行为一致", async () => {
    await useSessionStore.getState().switchCwd("/proj/b");
    expect(opened).toEqual([]);
    expect(useUiStore.getState().currentCwd).toBe("/proj/b");
    expect(useUiStore.getState().currentSessionPath).toBeNull();
  });

  it("有记忆且可打开:切过去恢复该项目上次的会话(高亮/标题/路径一起回来)", async () => {
    useUiStore.setState({ lastSessionByCwd: { "/proj/b": "ns-b1" } });
    detailFor = () => detail("/proj/b", "ns-b1", "/proj/b/s/b1.jsonl");
    await useSessionStore.getState().switchCwd("/proj/b");
    expect(opened).toEqual(["ns-b1"]);
    expect(useUiStore.getState().currentNeutralSessionId).toBe("ns-b1");
    expect(useUiStore.getState().currentSessionPath).toBe("/proj/b/s/b1.jsonl");
    expect(useUiStore.getState().sessionTitle).toBe("ns-b1");
  });

  it("记忆失效(文件已删,openSession 返回 null):退新会话,不抛错、不留半开上下文", async () => {
    useUiStore.setState({ lastSessionByCwd: { "/proj/b": "ns-gone" } });
    detailFor = () => null;
    await useSessionStore.getState().switchCwd("/proj/b");
    expect(opened).toEqual(["ns-gone"]);
    expect(useUiStore.getState().currentSessionPath).toBeNull();
    expect(useUiStore.getState().currentNeutralSessionId).toBeNull();
  });

  it("记忆读取抛错(会话损坏/读盘失败):退新会话,不把切项目打断", async () => {
    useUiStore.setState({ lastSessionByCwd: { "/proj/b": "ns-broken" } });
    detailFor = () => { throw new Error("会话内容损坏"); };
    await useSessionStore.getState().switchCwd("/proj/b");
    expect(opened).toEqual(["ns-broken"]);
    expect(useUiStore.getState().currentCwd).toBe("/proj/b");
    expect(useUiStore.getState().currentSessionPath).toBeNull();
  });

  it("点当前已激活的项目:幂等 no-op(不重载会话、不重开新会话)", async () => {
    useUiStore.setState({
      currentCwd: "/proj/a",
      currentSessionPath: "/proj/a/s/a1.jsonl",
      currentNeutralSessionId: "ns-a1",
    });
    await useSessionStore.getState().switchCwd("/proj/a");
    expect(opened).toEqual([]);
    expect(useUiStore.getState().currentSessionPath).toBe("/proj/a/s/a1.jsonl");
    expect(useUiStore.getState().currentNeutralSessionId).toBe("ns-a1");
  });

  it("打开成功即写穿记忆(ns 主键优先,内存 + prefs 同写)", async () => {
    detailFor = () => detail("/proj/a", "ns-a1", "/proj/a/s/a1.jsonl");
    await useSessionStore.getState().openSession("ns-a1");
    expect(useUiStore.getState().lastSessionByCwd["/proj/a"]).toBe("ns-a1");
    expect(prefsWrites.find((w) => w.key === "lastSessionByCwd")?.value).toEqual({ "/proj/a": "ns-a1" });
  });

  it("无 ns 的老会话:记忆回落投影路径(与 openSession 双形态归一一致)", async () => {
    detailFor = () => ({
      info: { cwd: "/proj/a", id: "legacy", path: "/proj/a/s/legacy.jsonl", created: "2026-01-01T00:00:00.000Z" },
      messages: [],
      stats: null,
    });
    await useSessionStore.getState().openSession("/proj/a/s/legacy.jsonl");
    expect(useUiStore.getState().lastSessionByCwd["/proj/a"]).toBe("/proj/a/s/legacy.jsonl");
  });

  it("startNewChat 不覆盖记忆(null 不写):冷启动那一次也不会把记忆清空", async () => {
    useUiStore.setState({ lastSessionByCwd: { "/proj/a": "ns-a1" } });
    await useSessionStore.getState().startNewChat("/proj/a");
    expect(useUiStore.getState().lastSessionByCwd["/proj/a"]).toBe("ns-a1");
    expect(prefsWrites.filter((w) => w.key === "lastSessionByCwd")).toEqual([]);
  });

  it("新会话物化(sessionStart 水合)补记记忆:在新会话壳里切走也有记录", async () => {
    hydrateSessionStart({
      type: "sessionStart",
      sessionFile: "/proj/a/s/new.jsonl",
      neutralSessionId: "ns-new",
    } as unknown as SessionEvent);
    expect(useUiStore.getState().lastSessionByCwd["/proj/a"]).toBe("ns-new");
  });

  it("startNewChat 清会话上下文三连(path/ns/title)——三处调用方不再各抄一遍", async () => {
    useUiStore.setState({
      currentSessionPath: "/proj/a/s/a1.jsonl",
      currentNeutralSessionId: "ns-a1",
      sessionTitle: "旧会话",
    });
    await useSessionStore.getState().startNewChat("/proj/a");
    const ui = useUiStore.getState();
    expect(ui.currentSessionPath).toBeNull();
    expect(ui.currentNeutralSessionId).toBeNull();
    expect(ui.sessionTitle).toBeNull();
  });
});

describe("refreshThinkingLevels → 档位清单跟着 session 的内核走(3:空清单置空,不串味)", () => {
  it("内核回空清单 → thinkingLevels 置空(非保留上一个内核的档位)", async () => {
    vi.stubGlobal("window", {
      kernel: { sessions: { pi: { getThinkingLevels: async () => [] } } },
    });
    // 前一个内核残留三档 + 当前会话有 thinking 面
    useSessionStore.setState({
      capabilities: { kernel: "dsh", locked: false, extension: false, thinking: true },
      thinkingLevels: ["off", "low", "high"],
    });
    refreshThinkingLevels();
    await new Promise((r) => setTimeout(r, 0));
    // 空清单是「该内核没有档位」的如实表达 → 置空(此前 `ls.length > 0` 会让旧值留着)
    expect(useSessionStore.getState().thinkingLevels).toEqual([]);
  });
});
