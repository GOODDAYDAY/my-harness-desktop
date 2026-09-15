// 圆心 session-scope 纯函数单测(设计 docs/design/session-scope.md §5.1)。
// 零依赖、不需要 mock 外部环境——按 CLAUDE.md §4.5 判据这是内层材料。
import { describe, it, expect } from "vitest";
import {
  sessionScopeKey,
  isShellScopeKey,
  scopeKeyFromSessionKey,
  sessionSlotKey,
  isMutableContainer,
  concatCarriedValues,
} from "./session-scope";

describe("sessionScopeKey:会话身份的唯一算法(设计 §2.2.1)", () => {
  it("已物化会话 = 中立主键 ns", () => {
    expect(sessionScopeKey("ns-abc", "/proj")).toBe("ns-abc");
  });

  it("未物化壳 = new:${cwd}", () => {
    expect(sessionScopeKey(null, "/proj")).toBe("new:/proj");
  });

  it("ns 优先于 cwd(两者都在时用 ns)", () => {
    expect(sessionScopeKey("ns-abc", "/proj")).toBe("ns-abc");
  });

  it("两者皆无 = null(没有激活会话)", () => {
    expect(sessionScopeKey(null, null)).toBeNull();
    expect(sessionScopeKey(null, "")).toBeNull();
    expect(sessionScopeKey("", "")).toBeNull();
    expect(sessionScopeKey(undefined, undefined)).toBeNull();
  });

  it("空串不当身份(空 ns 回落壳键,空 cwd 回落 null)", () => {
    expect(sessionScopeKey("", "/proj")).toBe("new:/proj");
    expect(sessionScopeKey("", "")).toBeNull();
  });

  it("投影路径不参与:同一 ns 在不同投影路径下作用域 key 相同(口径单源的直接推论)", () => {
    // 设计 §1.1.2 的根因:消费方拿投影路径当身份,dsh 会话(裸 lineageId)与旧 pi 会话
    // (可能没有投影文件)会落到错误的桶。身份只认 ns,所以投影路径怎么变都不影响。
    expect(sessionScopeKey("ns-abc", "/proj")).toBe(sessionScopeKey("ns-abc", "/other"));
  });
});

describe("isShellScopeKey:壳键判别与 sessionScopeKey 的壳键分支同源", () => {
  it("壳键形态命中", () => {
    expect(isShellScopeKey(sessionScopeKey(null, "/proj")!)).toBe(true);
  });

  it("真身 ns 不命中", () => {
    expect(isShellScopeKey(sessionScopeKey("ns-abc", "/proj")!)).toBe(false);
  });
});

describe("scopeKeyFromSessionKey:main 侧 proc.key 归一(设计 §2.2.2)", () => {
  it("查表命中 → 返回中立主键", () => {
    const lookup = (k: string): string | undefined =>
      k === "/proj/sessions/x.jsonl" ? "ns-x" : undefined;
    expect(scopeKeyFromSessionKey("/proj/sessions/x.jsonl", lookup)).toBe("ns-x");
  });

  it("查表未命中 → key 本身就是 ns(正常态),原样返回", () => {
    expect(scopeKeyFromSessionKey("ns-y", () => undefined)).toBe("ns-y");
  });

  it("lookup 返回 null 也按未命中处理(?? 同时兜 undefined 与 null)", () => {
    expect(scopeKeyFromSessionKey("k", () => null)).toBe("k");
  });

  it("fork 过的会话:proc.key 已 rekey 不等于投影路径,查表后仍归一到同一 ns", () => {
    // 设计 §1.1.2 记录的 round 双跳根因:拿 rekey 后的 proc.key 直接比投影路径会误判成
    // 「后台会话」,视图流归一次账、后台再归一次账。归一后两者收敛到同一 ns。
    const byPath = new Map([["/proj/sessions/ns-z.jsonl", "ns-z"]]);
    const lookup = (k: string): string | undefined => byPath.get(k);
    const rekeyedProcKey = "/proj/sessions/fork-1.jsonl"; // rekey 后的 key,表里没有
    const tableWithRekey = new Map([[rekeyedProcKey, "ns-z"]]);
    expect(scopeKeyFromSessionKey(rekeyedProcKey, (k) => tableWithRekey.get(k))).toBe("ns-z");
    expect(scopeKeyFromSessionKey("/proj/sessions/ns-z.jsonl", lookup)).toBe("ns-z");
  });
});

describe("sessionSlotKey:命名空间键拼装单源(设计 §2.3.1)", () => {
  it("pluginId 与 slotId 拼成 slotKey", () => {
    expect(sessionSlotKey("goal", "goal")).toBe("goal:goal");
    expect(sessionSlotKey("review", "basket")).toBe("review:basket");
  });

  it("不同插件的同名槽不撞键(命名空间隔离)", () => {
    expect(sessionSlotKey("a", "state")).not.toBe(sessionSlotKey("b", "state"));
  });
});

describe("isMutableContainer:值形态可变容器的注册期告警判据(设计 §2.2.3)", () => {
  it("对象/数组/Map/Set 都算(共享实例会让隔离失效)", () => {
    expect(isMutableContainer({})).toBe(true);
    expect(isMutableContainer([])).toBe(true);
    expect(isMutableContainer(new Map())).toBe(true);
    expect(isMutableContainer(new Set())).toBe(true);
  });

  it("null 与标量不算", () => {
    expect(isMutableContainer(null)).toBe(false);
    expect(isMutableContainer(undefined)).toBe(false);
    expect(isMutableContainer(0)).toBe(false);
    expect(isMutableContainer("")).toBe(false);
    expect(isMutableContainer(false)).toBe(false);
  });

  it("函数形态是工厂,不在此列(工厂是正确写法,不该告警)", () => {
    expect(isMutableContainer(() => new Map())).toBe(false);
  });
});

describe("concatCarriedValues:concat 策略的合并语义(设计 §2.2.4/§2.3.2)", () => {
  it("两侧都是数组 → 追加(目标在前,搬来的在后)", () => {
    expect(concatCarriedValues([1, 2], [3])).toEqual({ value: [1, 2, 3], degraded: false });
  });

  it("目标为空 → 直接落搬来的值(不降级)", () => {
    expect(concatCarriedValues(undefined, ["a"])).toEqual({ value: ["a"], degraded: false });
    expect(concatCarriedValues(undefined, 5 as unknown as string[])).toEqual({ value: 5, degraded: false });
  });

  it("非数组值且目标已有值 → 降级为 move(以目标为准)并显式标记 degraded", () => {
    // 不静默:degraded=true 让调用方发 dev 告警,声明者知道自己声明错了策略。
    expect(concatCarriedValues({ a: 1 }, { b: 2 })).toEqual({ value: { a: 1 }, degraded: true });
  });

  it("降级不丢数据:目标的值原样保留", () => {
    const dst = new Map([["k", "v"]]);
    const src = new Map([["k2", "v2"]]);
    expect(concatCarriedValues(dst, src).value).toBe(dst);
  });
});
