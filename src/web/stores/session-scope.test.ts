// 会话作用域容器 store 单测(设计 docs/design/session-scope.md §5.1)。
// 纯逻辑:store 经注入拿身份(setScopeKeyResolver),不 import ui-store,所以测试不需要 mock 外层——
// 直接给 resolver 喂一个测试值即可(这正是 §2.2.1 注入式设计对可测性的回报)。
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useSessionScopeStore,
  readTolerant,
  readFrameworkSlot,
  writeFrameworkSlot,
  setScopeKeyResolver,
  currentScopeKey,
  onScopeDrop,
  FRAMEWORK_PLUGIN_ID,
  __resetScopesForTests,
} from "./session-scope";
import { sessionSlotKey } from "@my-harness-desktop/shared";

// 注意:store 的 set 会替换 scopes/slots 引用,断言前必须重新 getState()——
// 持旧快照断言会读到 stale 的 Map(这是 zustand 的常规陷阱,不是实现问题)。
const P = "test-plugin";
const key = (id: string): string => sessionSlotKey(P, id);

/** 注册一批测试槽(每个测试自带声明,互不干扰)。 */
function reg(slots: Parameters<ReturnType<typeof useSessionScopeStore.getState>["registerSlots"]>[1]): void {
  useSessionScopeStore.getState().registerSlots(P, slots);
}

beforeEach(() => {
  __resetScopesForTests();
  setScopeKeyResolver(() => "ns-active");
  vi.restoreAllMocks();
});

describe("隔离:作用域容器把每会话的态分开(设计 §2.1.2 声明即隔离)", () => {
  it("两会话同槽互不覆盖", () => {
    reg([{ id: "goal", initial: null }]);
    const st = useSessionScopeStore.getState();
    st.write(key("goal"), "ns-A", { objective: "A 的目标" });
    st.write(key("goal"), "ns-B", { objective: "B 的目标" });
    expect(st.read(key("goal"), "ns-A")).toEqual({ objective: "A 的目标" });
    expect(st.read(key("goal"), "ns-B")).toEqual({ objective: "B 的目标" });
  });

  it("后台会话的槽常驻,不只激活那一份(设计 §2.3.3)", () => {
    reg([{ id: "busy", initial: false, carry: "drop" }]);
    const st = useSessionScopeStore.getState();
    st.write(key("busy"), "ns-A", true);       // A 在后台跑
    setScopeKeyResolver(() => "ns-B");          // 用户切到 B
    expect(st.read(key("busy"), "ns-A")).toBe(true);   // A 域仍在,归账有处可写
    expect(st.read(key("busy"), "ns-B")).toBe(false);  // B 读到自己的 false
  });
});

describe("carry:物化搬迁按各槽策略搬(设计 §2.3.2/§2.2.4)", () => {
  it("move:目标为空则搬过去,删旧域", () => {
    reg([{ id: "draft", initial: "", carry: "move" }]);
    const st = useSessionScopeStore.getState();
    st.write(key("draft"), "new:/proj", "还没写完");
    st.carry("new:/proj", "ns-real");
    // carry 用 set 换了 scopes 引用,断言必须重新 getState(旧快照是 stale 的)
    const after = useSessionScopeStore.getState();
    expect(after.read(key("draft"), "ns-real")).toBe("还没写完");
    expect(after.scopes.has("new:/proj")).toBe(false);
  });

  it("move:目标已有值则以目标为准(不覆盖)", () => {
    reg([{ id: "draft", initial: "", carry: "move" }]);
    const st = useSessionScopeStore.getState();
    st.write(key("draft"), "new:/proj", "壳期的草稿");
    st.write(key("draft"), "ns-real", "真身已有的草稿");
    st.carry("new:/proj", "ns-real");
    expect(st.read(key("draft"), "ns-real")).toBe("真身已有的草稿");
  });

  it("concat:追加到目标已有值之后", () => {
    reg([{ id: "basket", initial: () => [], carry: "concat" }]);
    const st = useSessionScopeStore.getState();
    st.write(key("basket"), "new:/proj", ["评论1"]);
    st.write(key("basket"), "ns-real", ["评论2"]);
    st.carry("new:/proj", "ns-real");
    expect(st.read(key("basket"), "ns-real")).toEqual(["评论2", "评论1"]);
  });

  it("drop:不搬,值随旧域一起丢", () => {
    reg([{ id: "inflight", initial: () => new Set<string>(), carry: "drop" }]);
    const st = useSessionScopeStore.getState();
    st.write<string[]>(key("inflight"), "new:/proj", ["id1"] as unknown as string[]);
    st.carry("new:/proj", "ns-real");
    // 目标域没有这个槽(未搬);读会惰性建初值(空 Set)
    expect(st.read(key("inflight"), "ns-real")).toEqual(new Set());
  });

  it("carry from===to 或 from 不存在 → 空操作", () => {
    reg([{ id: "x", initial: 0 }]);
    const st = useSessionScopeStore.getState();
    const before = st.nonce;
    st.carry("ns-same", "ns-same");
    st.carry("ns-nonexistent", "ns-to");
    expect(useSessionScopeStore.getState().nonce).toBe(before);
  });

  it("onCarry 在搬迁后按新 key(toKey)调用,值是搬进新键的那份", async () => {
    const onCarry = vi.fn();
    reg([{ id: "goal", initial: null, carry: "move", onCarry }]);
    const st = useSessionScopeStore.getState();
    st.write(key("goal"), "new:/proj", { objective: "目标甲" });
    st.carry("new:/proj", "ns-real");
    await Promise.resolve();   // onCarry 在 microtask 里
    await Promise.resolve();
    expect(onCarry).toHaveBeenCalledWith({ objective: "目标甲" }, "ns-real");
  });

  it("onCarry 的 toKey 是 carry 当时的目标,不是回调时的当前 scopeKey(设计 §2.2.5)", async () => {
    const seen: string[] = [];
    reg([{ id: "goal", initial: null, onCarry: (_v, toKey) => { seen.push(toKey); } }]);
    const st = useSessionScopeStore.getState();
    st.write(key("goal"), "new:/proj", { o: 1 });
    st.carry("new:/proj", "ns-real");
    setScopeKeyResolver(() => "ns-OTHER");   // microtask 落地前用户切走
    await Promise.resolve();
    await Promise.resolve();
    // 钩子拿到的是 carry 的 to(ns-real),不是切换后的 ns-OTHER——否则头行补写会写错会话
    expect(seen).toEqual(["ns-real"]);
  });
});

describe("drop:摘除整个作用域(设计 §2.3.2)", () => {
  it("逐槽调 onLeave 后摘域", () => {
    const onLeave = vi.fn();
    reg([{ id: "ledger", initial: () => new Map(), carry: "drop", onLeave }]);
    const st = useSessionScopeStore.getState();
    const m = st.read<Map<string, unknown>>(key("ledger"), "ns-A");
    m.set("k", "v");
    st.drop("ns-A");
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onLeave.mock.calls[0][0]).toBe(m);
    expect(useSessionScopeStore.getState().scopes.has("ns-A")).toBe(false);
  });

  it("通知 scopeDrop 监听器(事件总线清回放桶的汇合点,设计 §2.5.3)", () => {
    reg([{ id: "x", initial: 0 }]);
    const dropped: string[] = [];
    const off = onScopeDrop((k) => dropped.push(k));
    useSessionScopeStore.getState().read(key("x"), "ns-A");
    useSessionScopeStore.getState().drop("ns-A");
    expect(dropped).toEqual(["ns-A"]);
    off();
  });

  it("drop 不存在的域 → 空操作、不调 onLeave", () => {
    const onLeave = vi.fn();
    reg([{ id: "x", initial: 0, onLeave }]);
    useSessionScopeStore.getState().drop("ns-ghost");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("onLeave 抛错被隔离,不阻断其余槽与摘域", () => {
    reg([
      { id: "bad", initial: 0, onLeave: () => { throw new Error("炸"); } },
      { id: "good", initial: 0, onLeave: vi.fn() },
    ]);
    const st = useSessionScopeStore.getState();
    st.read(key("bad"), "ns-A");
    st.read(key("good"), "ns-A");
    expect(() => st.drop("ns-A")).not.toThrow();
    expect(useSessionScopeStore.getState().scopes.has("ns-A")).toBe(false);
  });
});

describe("惰性建域与初值(设计 §2.3.4)", () => {
  it("首次 read 才建域,落初值递增 nonce", () => {
    reg([{ id: "x", initial: 42 }]);
    const st = useSessionScopeStore.getState();
    expect(st.scopes.has("ns-new")).toBe(false);
    const before = st.nonce;
    expect(st.read(key("x"), "ns-new")).toBe(42);
    expect(useSessionScopeStore.getState().scopes.has("ns-new")).toBe(true);
    expect(useSessionScopeStore.getState().nonce).toBe(before + 1);
  });

  it("工厂形态不共享实例:两会话各拿一份新 Map(设计 §2.2.3)", () => {
    reg([{ id: "ledger", initial: () => new Map() }]);
    const st = useSessionScopeStore.getState();
    const a = st.read<Map<string, unknown>>(key("ledger"), "ns-A");
    const b = st.read<Map<string, unknown>>(key("ledger"), "ns-B");
    expect(a).not.toBe(b);
    a.set("k", "v");
    expect(b.has("k")).toBe(false);
  });

  it("值形态可变容器触发 dev 告警(注册期拦截共享实例陷阱)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reg([{ id: "shared", initial: new Map() }]);   // 错:值形态
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("共享同一实例");
  });

  it("工厂形态不告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reg([{ id: "ok", initial: () => new Map() }]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("未注册槽的两种失败形态(设计 §2.3.4)", () => {
  it("read(非渲染侧)抛错——显式失败优于静默 undefined", () => {
    expect(() => useSessionScopeStore.getState().read(key("ghost"), "ns-A")).toThrow(/未注册的会话槽/);
  });

  it("readTolerant(渲染侧)返回 undefined + dev 告警,不抛", () => {
    const err = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readTolerant(key("ghost"), "ns-A")).toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it("readTolerant 告警按 slotKey 去重(不刷屏)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readTolerant(key("ghost"), "ns-A");
    readTolerant(key("ghost"), "ns-B");
    readTolerant(key("ghost"), "ns-C");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("currentScopeKey:身份经 resolver 注入(设计 §2.2.1)", () => {
  it("resolver 返回值即当前 scopeKey", () => {
    setScopeKeyResolver(() => "ns-X");
    expect(currentScopeKey()).toBe("ns-X");
  });

  it("resolver 未注入 → null + 告警,不抛(装配顺序问题不该变白屏)", () => {
    setScopeKeyResolver(null as unknown as () => string | null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(currentScopeKey()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("unregisterSlots:插件卸载摘槽(设计 §2.4.4)", () => {
  it("摘注册表 + 对每个会话域的已存在值调 onLeave,但不删 scopes 数据(热装恢复)", () => {
    const onLeave = vi.fn();
    reg([{ id: "goal", initial: null, onLeave }]);
    const st = useSessionScopeStore.getState();
    st.write(key("goal"), "ns-A", { o: "A" });
    st.write(key("goal"), "ns-B", { o: "B" });
    st.unregisterSlots(P);
    const after = useSessionScopeStore.getState();   // unregister 换了 slots 引用
    // 两个域的值都调了 onLeave(不只激活域)
    expect(onLeave).toHaveBeenCalledTimes(2);
    // 注册表摘了
    expect(after.slots.has(key("goal"))).toBe(false);
    // 但数据留着——热装回来 registerSlots 后 read 到原值,不重新 initial
    expect(after.scopes.get("ns-A")?.get(key("goal"))).toEqual({ o: "A" });
  });

  it("框架槽不随插件卸载(FRAMEWORK_PLUGIN_ID 不在任何插件路径上)", () => {
    const before = useSessionScopeStore.getState().slots.has(sessionSlotKey(FRAMEWORK_PLUGIN_ID, "toolResultLedger"));
    useSessionScopeStore.getState().unregisterSlots(P);
    const after = useSessionScopeStore.getState().slots.has(sessionSlotKey(FRAMEWORK_PLUGIN_ID, "toolResultLedger"));
    expect(before).toBe(true);
    expect(after).toBe(true);
  });
});

describe("框架六个保留槽自注册(设计 §2.6.1)", () => {
  // overlay 不在容器里(实现期修正:它是 session-store 的 state 字段、与 streaming/snapshot
  // 同一原子 setState、视图流只投激活会话,迁进来会拆原子性且多会话并存能力对它是空的;
  // 见 session-scope.ts 框架槽注释块与 §4.5.4「存得下≠该存」)。
  const FRAMEWORK_SLOTS = ["toolResultLedger", "inflightToolCalls", "modelPending", "pendingQueue", "composerDraft", "toolConfig"];

  it("六个槽全部注册在 FRAMEWORK_PLUGIN_ID 下", () => {
    const st = useSessionScopeStore.getState();
    for (const id of FRAMEWORK_SLOTS) {
      expect(st.slots.has(sessionSlotKey(FRAMEWORK_PLUGIN_ID, id))).toBe(true);
    }
  });

  it("readFrameworkSlot/writeFrameworkSlot 读写当前作用域", () => {
    writeFrameworkSlot("modelPending", "ns-A", { provider: "p", modelId: "m" });
    expect(readFrameworkSlot("modelPending", "ns-A")).toEqual({ provider: "p", modelId: "m" });
  });

  it("toolResultLedger/inflightToolCalls 工厂初值不共享(两会话各一份,设计 §1.1.3 撞 id 隔离)", () => {
    const a = readFrameworkSlot<Set<string>>("inflightToolCalls", "ns-A");
    const b = readFrameworkSlot<Set<string>>("inflightToolCalls", "ns-B");
    expect(a).not.toBe(b);
    a.add("tool-1");
    expect(b.has("tool-1")).toBe(false);   // A 的在飞态不串到 B
  });
});

describe("write:函数式更新 + nonce 递增", () => {
  it("setter 收函数时按前值算", () => {
    reg([{ id: "round", initial: 0 }]);
    const st = useSessionScopeStore.getState();
    st.write<number>(key("round"), "ns-A", (p) => p + 1);
    st.write<number>(key("round"), "ns-A", (p) => p + 1);
    expect(st.read(key("round"), "ns-A")).toBe(2);
  });

  it("每次 write 递增 nonce(双层 Map 内层写不换外层引用,靠 nonce 驱动重渲染)", () => {
    reg([{ id: "x", initial: 0 }]);
    const st = useSessionScopeStore.getState();
    const n0 = st.nonce;
    st.write(key("x"), "ns-A", 1);
    expect(useSessionScopeStore.getState().nonce).toBe(n0 + 1);
  });
});
