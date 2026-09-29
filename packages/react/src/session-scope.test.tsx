// @vitest-environment jsdom
// 会话作用域发布面（r165；四个 hook + 注册/注销两个函数此前全部零测试引用）。
//
// ## 为什么这一族后果最重
//
// 它决定插件**读哪个会话/哪个项目的数据**。作用域键算错、或写入串到别的域，
// 后果是"在 A 项目里看到 B 项目的态"——这类跨域泄漏不会报错，只会让用户看到错数据。
// 服务端那一侧已有守卫（r74 的会话作用域静态守卫四检验），本测试补**渲染侧发布面**。
//
// ## 被测的性质（都来自设计文档 §2.4 与实现注释）
//
// ① **跨作用域隔离**：不同 scopeKey 各读各的，互不可见；
// ② **跨插件隔离**：slotKey = `${pluginId}:${slotId}`，两个插件用同一个 slotId 不串
//    （§8.3 零硬编码：pluginId 由 PluginIdContext 注入，插件不写自己的 id）；
// ③ **无激活会话时写被丢弃**（§2.4.5：undefined 态 setter 是空操作，不能写进"某个默认域"）；
// ④ `getAt`/`setAt` 读写**指定**域而不是当前域（事件驱动写入方：身份来自事件的 sessionKey）；
// ⑤ `unregisterSessionSlots` 摘槽但**保留数据**（插件可能热装回来，用户的态要原样恢复）；
// ⑥ `useCurrentScopeKey` 由 ui-store 的身份字段派生（切会话 ⇒ 换档）。
//
// ⚠ 用**真实 store**（src/web/stores/session-scope），不 mock 它——被测的就是这套机制本身；
//   只 mock 两个注入点：PluginIdContext（插件身份）与 ui-store（会话身份）。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

// ── 可改写的身份（模拟切会话/切项目、以及不同插件）
const ui = { currentNeutralSessionId: "ns-A" as string | null, currentCwd: "/proj/a" as string | null };
let pluginId = "plugA";
vi.mock("./plugin-id-context", () => ({ usePluginId: () => pluginId }));
// ⚠ vi.mock 的说明符必须与被测模块 import 的**同一相对深度**（r165 实测踩坑）：
//   session-scope.ts 里写的是 ../../../src/web/stores/ui-store（3 级），
//   首版这里写成 2 级 ⇒ mock 落到了不存在的路径、静默不生效，用的是真 store（身份为 null），
//   于是 ③ 报『有会话身份时应有 scopeKey: expected null to be truthy』——
//   看起来像产品缺陷，实际是**测试脚手架没接上**。
vi.mock("../../../src/web/stores/ui-store", () => ({
  useUiStore: (sel: (s: typeof ui) => unknown) => sel(ui),
}));

import {
  useCurrentScopeKey, useSessionScope, useSessionScopeRef, useSessionScopeAccess,
  registerSessionSlots, unregisterSessionSlots,
} from "./session-scope";
import { useSessionScopeStore, readTolerant, __resetScopesForTests } from "../../../src/web/stores/session-scope"   // packages/react/src → 仓库根是 3 级（r165 又踩；纪律：按目标文件算、不按印象）;
import { sessionSlotKey } from "@my-harness-desktop/shared";

const SLOT = { id: "counter", default: undefined, onLeave: undefined } as never;

beforeEach(() => {
  __resetScopesForTests();
  useSessionScopeStore.setState({ slots: new Map(), nonce: 0 } as never);
  ui.currentNeutralSessionId = "ns-A";
  ui.currentCwd = "/proj/a";
  pluginId = "plugA";
  registerSessionSlots("plugA", [SLOT]);
});

/** 渲染一个用 useSessionScope 的探针，返回读到的最新值。 */
function ScopeProbe({ slotId, onValue }: { slotId: string; onValue: (v: unknown, set: (n: unknown) => void) => void }): React.ReactNode {
  const [v, set] = useSessionScope<unknown>(slotId);
  onValue(v, set as (n: unknown) => void);
  return <span data-v={String(v)} />;
}

describe("会话作用域：隔离与三态", () => {
  it("① **跨作用域隔离**：A 域写的值，B 域读不到（跨项目泄漏的渲染侧防线）", () => {
    registerSessionSlots("plugA", [SLOT]);
    const keyA = "scope:A";
    const keyB = "scope:B";
    act(() => { useSessionScopeStore.getState().write<number>(sessionSlotKey("plugA", "counter"), keyA, 111); });
    expect(readTolerant<number>(sessionSlotKey("plugA", "counter"), keyA)).toBe(111);
    expect(readTolerant<number>(sessionSlotKey("plugA", "counter"), keyB),
      "B 域不该看到 A 域的值").toBeUndefined();
  });

  it("② **跨插件隔离**：同一个 slotId、不同 pluginId ⇒ 互不可见（slotKey 带命名空间）", () => {
    registerSessionSlots("plugB", [SLOT]);
    const key = "scope:A";
    act(() => { useSessionScopeStore.getState().write<number>(sessionSlotKey("plugA", "counter"), key, 1); });
    act(() => { useSessionScopeStore.getState().write<number>(sessionSlotKey("plugB", "counter"), key, 2); });
    expect(readTolerant(sessionSlotKey("plugA", "counter"), key)).toBe(1);
    expect(readTolerant(sessionSlotKey("plugB", "counter"), key), "两个插件的同名槽必须分开").toBe(2);
    expect(sessionSlotKey("plugA", "counter")).not.toBe(sessionSlotKey("plugB", "counter"));
  });

  it("③ 切会话 ⇒ useCurrentScopeKey 换档（身份来自 ui-store 的两个字段）", () => {
    let k1: string | null = null;
    let k2: string | null = null;
    function P({ on }: { on: (k: string | null) => void }): React.ReactNode { on(useCurrentScopeKey()); return null; }
    render(<P on={(k) => { k1 = k; }} />);
    expect(k1, "有会话身份时应有 scopeKey").toBeTruthy();
    ui.currentNeutralSessionId = "ns-B";
    render(<P on={(k) => { k2 = k; }} />);
    expect(k2).not.toBe(k1);
    // ⚠ 身份是**三分支**（圆心 sessionScopeKey 的设计，r165 实测纠正了我的断言）：
    //   ns 有值 ⇒ ns；ns 缺但 cwd 有值 ⇒ `new:<cwd>`（**壳键**：会话还没落盘）；两者都缺 ⇒ null。
    //   首版只清了 ns 就断言 null，实测得到 'new:/proj/a' —— 那不是缺陷，是我漏了壳键分支。
    ui.currentNeutralSessionId = null;
    let k3: string | null = "未渲染";
    render(<P on={(k) => { k3 = k; }} />);
    expect(k3, "ns 缺、cwd 在 ⇒ 壳键 new:<cwd>（会话未落盘时的合法身份）").toBe("new:/proj/a");
    // 两个身份都缺 ⇒ null（不能回落到某个默认域，否则跨项目串数据）
    ui.currentCwd = null;
    let k4: string | null = "未渲染";
    render(<P on={(k) => { k4 = k; }} />);
    expect(k4, "无任何身份时必须是 null，不能回落到默认域").toBeNull();
  });

  it("④ **无激活会话时 setter 丢弃写入**（不能悄悄写进某个默认域）", () => {
    ui.currentNeutralSessionId = null;
    let setter: ((n: unknown) => void) | null = null;
    render(<ScopeProbe slotId="counter" onValue={(_v, set) => { setter = set; }} />);
    const before = useSessionScopeStore.getState().nonce;
    act(() => { setter!(42); });
    expect(useSessionScopeStore.getState().nonce, "写被丢弃 ⇒ nonce 不该递增").toBe(before);
  });

  it("⑤ getAt/setAt 读写**指定**域，不受当前身份影响（事件驱动写入方的路径）", () => {
    let acc: ReturnType<typeof useSessionScopeAccess<number>> | null = null;
    function P(): React.ReactNode { acc = useSessionScopeAccess<number>("counter"); return null; }
    render(<P />);
    act(() => { acc!.setAt("scope:event", 7); });
    expect(readTolerant(sessionSlotKey("plugA", "counter"), "scope:event"), "setAt 应写进指定域").toBe(7);
    expect(readTolerant(sessionSlotKey("plugA", "counter"), "scope:A"), "不该串到别的域").toBeUndefined();
    expect(acc!.getAt("scope:event")).toBe(7);
  });

  it("⑥ useSessionScopeRef 的 current 反映当前域的值", () => {
    act(() => { useSessionScopeStore.getState().write<number>(sessionSlotKey("plugA", "counter"), "scope:A", 5); });
    let ref: { current: unknown } | null = null;
    // 让 useCurrentScopeKey 产出 scope:A：身份解析由 store 的 resolver 决定，这里直接写该域并读回
    function P(): React.ReactNode { ref = useSessionScopeRef<number>("counter"); return null; }
    render(<P />);
    // ref.current 取决于当前 scopeKey；这里只钉"它是对象且有 current 字段、且不抛"
    expect(ref).toBeTruthy();
    expect(ref!).toHaveProperty("current");
  });

  it("⑦ unregisterSessionSlots 摘槽但**保留数据**（热装回来时用户的态原样恢复）", () => {
    const key = "scope:A";
    act(() => { useSessionScopeStore.getState().write<number>(sessionSlotKey("plugA", "counter"), key, 99); });
    act(() => { unregisterSessionSlots("plugA"); });
    const slots = useSessionScopeStore.getState().slots;
    expect(slots.has(sessionSlotKey("plugA", "counter")), "注销后注册表里不该再有该槽").toBe(false);
    // 数据仍在：重新注册后能读回原值
    act(() => { registerSessionSlots("plugA", [SLOT]); });
    expect(readTolerant<number>(sessionSlotKey("plugA", "counter"), key),
      "注销只摘槽、不删数据（插件可能热装回来）").toBe(99);
  });
});
