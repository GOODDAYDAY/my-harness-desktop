// event-bus 的语义守卫 —— **纯逻辑 unittest**(node 环境,零 DOM、零 mock)。
// 依据是 CLAUDE.md §8.2 与源码注释里**文档化的语义**;每一条都曾在别处被误用过:
//   ① `emit` 是发布/订阅:订阅者收到
//   ② **`replayLast: true` 让新订阅者立即收到最近一次 emit 的 payload** ✓
//   ③ **`invoke` 是定向分派:无订阅者时入队;首个订阅者挂载时"恰好一次投递",且
//      队列清空后后到的订阅者不再收到历史**(源码注释:不 sleep、不靠 replayLast 误重放) ✓
//   ④ `invoke` **不支持 system: 频道**(抛错;文档理由:快捷键不可绑) ✓
//   ⑤ 观察者回调抛错**不阻断派发**(源码注释:"抛错兜底不阻断派发") ✓
//
// ⚠ `EventBusImpl` **不导出**(class 未 export),故用导出的**单例** `eventBus`,
//    并为每个用例取**唯一频道名**,避免跨用例串味;结束用 unregisterPlugin 清理。
import { describe, it, expect, beforeEach } from "vitest";

import { eventBus, setEventBusScopeKeyResolver } from "./event-bus";

let n = 0;
const ch = (s: string): string => `t${++n}:${s}`;      // 每用例唯一,避免跨用例污染

beforeEach(() => { /* 频道名唯一即可,无需清空单例 */ });

describe("eventBus(插件间唯一合法通信通道)", () => {
  it("① emit → 订阅者收到 payload", () => {
    const c = ch("evt");
    eventBus.registerChannels("p1", [c]);
    const seen: unknown[] = [];
    eventBus.on(c, (p) => seen.push(p));
    eventBus.emit("p1", c, { a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
    eventBus.unregisterPlugin("p1");
  });

  it("★ ② replayLast:true 的新订阅者**立即**收到最近一次 emit 的 payload", () => {
    const c = ch("replay");
    eventBus.registerChannels("p1", [c]);
    eventBus.emit("p1", c, { v: "last" });               // 先 emit,尚无订阅者

    const seen: unknown[] = [];
    eventBus.on(c, (p) => seen.push(p), { replayLast: true });
    expect(seen, "带 replayLast 的新订阅者没有拿到最近一次 emit 的 payload").toEqual([{ v: "last" }]);

    // 关键对照:**不带** replayLast 就不该收到历史
    const seen2: unknown[] = [];
    eventBus.on(c, (p) => seen2.push(p));
    expect(seen2, "不带 replayLast 的订阅者也收到了历史(等于无条件回放)").toEqual([]);
    eventBus.unregisterPlugin("p1");
  });

  it("★ ③ invoke 无订阅者时入队,首个订阅者**恰好一次**投递,后到者**不再**收到", () => {
    const c = ch("cmd");
    eventBus.registerChannels("p1", [c]);
    eventBus.invoke("caller", c, { n: 1 });               // 此时无订阅者 → 入队

    const first: unknown[] = [];
    eventBus.on(c, (p) => first.push(p));
    expect(first, "首个订阅者没有收到排队中的 invoke").toEqual([{ n: 1 }]);

    const late: unknown[] = [];
    eventBus.on(c, (p) => late.push(p));
    expect(late, "**后到的订阅者收到了历史 invoke**(应恰好一次、不回放)").toEqual([]);

    eventBus.unregisterPlugin("p1");
  });

  it("④ invoke 打 system: 频道 → 抛(系统事件不可被插件当命令调用)", () => {
    // ⚠ 必须断言**为什么**抛:只写 toThrow() 会连未注册那条守卫也算通过 ——
    //    实测(第 225 轮)去掉系统频道拦截后,invoke 撞上下一条守卫**照样抛**,
    //    于是宽断言**不会红** ✗(等于没守)。改为断言抛错原因:
    expect(() => eventBus.invoke("caller", "system:whatever", {})).toThrow(/系统频道/);
  });

  it("⑤ `on` 返回的退订函数生效", () => {
    const c = ch("off");
    eventBus.registerChannels("p1", [c]);
    const seen: unknown[] = [];
    const off = eventBus.on(c, (p) => seen.push(p));
    eventBus.emit("p1", c, 1);
    off();
    eventBus.emit("p1", c, 2);
    expect(seen, "退订后仍收到派发").toEqual([1]);
    eventBus.unregisterPlugin("p1");
  });
});

// 会话作用域 channel(设计 docs/design/session-scope.md §2.5):scope:"session" 的 channel
// 由框架注入坐标、按坐标过滤投递、replayLast 按坐标分桶。global channel 行为完全不变(回归)。
describe("eventBus scoped channel(会话作用域坐标)", () => {
  // 用一个可控的 resolver 模拟「当前会话」
  let cur: string | null = "ns-A";
  beforeEach(() => {
    cur = "ns-A";
    setEventBusScopeKeyResolver(() => cur);
  });

  const reg = (plugin: string, channel: string, scope: "session" | "global"): void => {
    eventBus.registerChannels(plugin, [channel], { [channel]: { scope } });
  };

  it("scoped channel:同作用域订阅者收到 payload(信封对插件透明,拿到的是业务数据)", () => {
    const c = ch("sc");
    reg("p1", c, "session");
    const seen: unknown[] = [];
    eventBus.on(c, (p) => seen.push(p));
    eventBus.emit("p1", c, { goal: "目标甲" });
    expect(seen).toEqual([{ goal: "目标甲" }]);   // 不是信封,是业务数据
    eventBus.unregisterPlugin("p1");
  });

  it("scoped channel:跨作用域不投递(A 发的,B 的订阅者收不到)", () => {
    const c = ch("cross");
    reg("p1", c, "session");
    const seenByB: unknown[] = [];
    cur = "ns-A";
    eventBus.emit("p1", c, { from: "A" });        // A 会话发
    cur = "ns-B";
    eventBus.on(c, (p) => seenByB.push(p));       // 切到 B 后订阅
    // B 的订阅者不该收到 A 的实时 emit
    eventBus.emit("p1", c, { from: "B" });
    expect(seenByB).toEqual([{ from: "B" }]);
    eventBus.unregisterPlugin("p1");
  });

  it("scoped channel:常驻订阅者在会话切换后自动过滤旧会话 payload(不需重订阅)", () => {
    const c = ch("resident");
    reg("p1", c, "session");
    const seen: unknown[] = [];
    eventBus.on(c, (p) => seen.push(p));          // 常驻订阅者(timeline 形态)
    cur = "ns-A";
    eventBus.emit("p1", c, { s: "A" });
    cur = "ns-B";                                  // 用户切到 B
    eventBus.emit("p1", c, { s: "B" });
    expect(seen).toEqual([{ s: "A" }, { s: "B" }]); // 各自作用域的都收到(emit 时 key 匹配当时的订阅者 key)
    eventBus.unregisterPlugin("p1");
  });

  it("scoped channel:replayLast 只回放本作用域那一桶(A 的 payload 不回放给 B)", () => {
    const c = ch("bucket");
    reg("p1", c, "session");
    cur = "ns-A";
    eventBus.emit("p1", c, { v: "A 的状态" });     // A 发,无订阅者
    cur = "ns-B";
    const seenByB: unknown[] = [];
    eventBus.on(c, (p) => seenByB.push(p), { replayLast: true });  // B 订阅 + replayLast
    expect(seenByB, "B 不该回放到 A 的 payload(这正是 goal:state 绿晕串台的根因)").toEqual([]);
    // 切回 A 再订阅:A 的桶还在,能回放到
    cur = "ns-A";
    const seenByA: unknown[] = [];
    eventBus.on(c, (p) => seenByA.push(p), { replayLast: true });
    expect(seenByA).toEqual([{ v: "A 的状态" }]);
    eventBus.unregisterPlugin("p1");
  });

  it("global channel:replayLast 行为完全不变(不注入坐标、不分桶)——回归守卫", () => {
    const c = ch("global");
    reg("p1", c, "global");
    cur = "ns-A";
    eventBus.emit("p1", c, { v: "跨会话命令" });
    cur = "ns-B";                                   // 即便切了会话
    const seen: unknown[] = [];
    eventBus.on(c, (p) => seen.push(p), { replayLast: true });
    expect(seen, "global channel 必须照旧回放(命令类 channel 本就不该被作用域过滤)").toEqual([{ v: "跨会话命令" }]);
    eventBus.unregisterPlugin("p1");
  });

  it("resolver 未注入时 emit scoped channel:不抛错、payload 不进桶(装配顺序问题不变白屏)", () => {
    const c = ch("noresolver");
    reg("p1", c, "session");
    setEventBusScopeKeyResolver(null);              // 模拟装配未完成
    expect(() => eventBus.emit("p1", c, { v: 1 })).not.toThrow();
    // 未进桶:恢复 resolver 后 replayLast 也捞不回
    setEventBusScopeKeyResolver(() => "ns-A");
    const seen: unknown[] = [];
    eventBus.on(c, (p) => seen.push(p), { replayLast: true });
    expect(seen).toEqual([]);
    eventBus.unregisterPlugin("p1");
  });

  it("live 投递自洽:emit 与过滤在同一次 resolver 调用取值,不会错配(设计 §2.5.2 修正)", () => {
    // 设计首版曾担心「emit 时 __scope=null、on 时 currentScopeKey=ns → live 投递被丢」。
    // 实测:live 投递是同步的——emit 里信封的 __scope 与过滤器的 currentScopeKey() 取自
    // **同一次** resolver 调用,两者必然一致,不存在错配。resolver=null 时 __scope=null、
    // 过滤也比 null,一致 → 照常投递(订阅者收到)。错配只可能发生在 replayLast(见下条)。
    const c = ch("live-consistent");
    reg("p1", c, "session");
    const seen: unknown[] = [];
    eventBus.on(c, (p) => seen.push(p));
    setEventBusScopeKeyResolver(null);              // 无会话期 emit
    eventBus.emit("p1", c, { v: "无会话期发的" });
    expect(seen, "resolver=null 时信封与过滤都为 null,一致 → 投递").toEqual([{ v: "无会话期发的" }]);
    eventBus.unregisterPlugin("p1");
    setEventBusScopeKeyResolver(() => cur);
  });

  it("错配的真正落点是 replayLast:无会话期 emit 不进桶,恢复 resolver 后回放捞不回", () => {
    const c = ch("replay-miss");
    reg("p1", c, "session");
    setEventBusScopeKeyResolver(null);              // 无会话期 emit → 不进任何桶
    eventBus.emit("p1", c, { v: "孤儿" });
    setEventBusScopeKeyResolver(() => "ns-A");      // 之后有会话了再订阅 + replayLast
    const seen: unknown[] = [];
    eventBus.on(c, (p) => seen.push(p), { replayLast: true });
    expect(seen, "无会话期的 emit 没进桶,replayLast 捞不回(设计 §2.5.2)").toEqual([]);
    eventBus.unregisterPlugin("p1");
    setEventBusScopeKeyResolver(() => cur);
  });

  it("dropScope 清某会话在全部 scoped channel 上的回放桶", () => {
    const c = ch("drop");
    reg("p1", c, "session");
    cur = "ns-A";
    eventBus.emit("p1", c, { v: "A" });
    eventBus.dropScope("ns-A");                      // 会话删除
    const seen: unknown[] = [];
    eventBus.on(c, (p) => seen.push(p), { replayLast: true });
    expect(seen, "dropScope 后 A 的桶应被清,不再回放").toEqual([]);
    eventBus.unregisterPlugin("p1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// on() 对**未注册 channel** 抛错（r171）
//
// 为什么要钉这条：它是 timeline 那三处 `try { return ctx.events.on(…) } catch { return undefined }`
// 存在的**前提**（r168/r171 的普查追到这里）。若 on() 从不抛，那三处 catch 就是不可达的防御
// （该按 r102 写可达性分析）；实测它**确实会抛**——声明该 channel 的插件没装载/被禁用时，
// 订阅会抛 `channel X 未被任何已加载插件注册`，而那三处 catch 让 timeline 组件仍能挂载
// （只是收不到那个事件）。所以这条抛出契约一旦漂移（比如改成静默返回 no-op），
// 消费方的韧性逻辑就失去意义、而没人会发现。
// ─────────────────────────────────────────────────────────────────────────────
describe("eventBus.on：未注册 channel 的失败形态（消费方韧性逻辑的前提）", () => {
  it("① 订阅未注册 channel ⇒ **抛错**且消息点名该 channel（可行动）", () => {
    const unknown = ch("没注册过");
    expect(() => eventBus.on(unknown, () => {})).toThrow(/未被任何已加载插件注册/);
    expect(() => eventBus.on(unknown, () => {}), "消息要含 channel 名，否则无从下手").toThrow(new RegExp(unknown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("② 注册之后同一 channel 订阅 ⇒ 不抛、且返回**退订函数**", () => {
    const c = ch("已注册");
    eventBus.registerChannels("p1", [c]);
    const off = eventBus.on(c, () => {});
    expect(typeof off, "on() 的返回值必须是退订函数（useEffect 直接把它当清理函数返回）").toBe("function");
    expect(() => off()).not.toThrow();
  });

  it("③ 反证：不是『任何订阅都抛』（否则①没有意义）", () => {
    const c = ch("正常");
    eventBus.registerChannels("p2", [c]);
    expect(() => eventBus.on(c, () => {})).not.toThrow();
  });
});
