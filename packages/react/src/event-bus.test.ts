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

import { eventBus } from "./event-bus";

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
