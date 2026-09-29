// @vitest-environment jsdom
// 工具卡片的 JSON.stringify 回落（r175；r173 覆盖率确证 tool-cards.tsx:40/48 未覆盖）。
//
// ## 被测的两处回落（都在私有助手里，经导出的 DefaultCard 测——r169 同法）
//
// · `fmtArgs`：参数对象里某个值不是字符串 ⇒ `JSON.stringify(v)`，**失败回落 `String(v)`**；
// · `fmtResult`：结果不是字符串 ⇒ `JSON.stringify(result, null, 2)`，**失败回落 `String(result)`**。
//
// 失败的真实成因是**循环引用**（内核工具结果里带回指自己的对象）或 BigInt。
// 后果若不兜：渲染阶段抛错 ⇒ 整条消息气泡被 ErrorBoundary 接管 ⇒
// 用户看到的是"渲染错误"红字，而不是"这个工具的参数长这样"。
// 兜住之后是**降级显示**（`[object Object]`），信息少了但不崩——§7.6 的显式降级。
//
// ⚠ 按 r169 的分层：容错要测两层——"序列化失败"（本轮）与"序列化成功"（既有行为，④⑤ 对照）。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh-CN" } }),
}));

import { DefaultCard } from "./tool-cards";

/** 循环引用对象（JSON.stringify 必抛）。 */
function circular(tag: string): Record<string, unknown> {
  const o: Record<string, unknown> = { tag };
  o.self = o;
  return o;
}
const tc = (over: Record<string, unknown>) =>
  ({ id: "t1", name: "some_unknown_tool", args: {}, state: "completed", ...over }) as never;

describe("DefaultCard：参数/结果无法序列化时降级显示而不是崩", () => {
  it("① args 里含循环引用 ⇒ **不崩**，且该值降级成 String() 形态", () => {
    expect(() => render(<DefaultCard toolCall={tc({ args: { payload: circular("a") } })} collapseDefault={false} />)).not.toThrow();
    // String({tag:'a', self:[Circular]}) === "[object Object]"
    expect(screen.getAllByText(/\[object Object\]/).length, "降级值应出现在参数区").toBeGreaterThan(0);
  });

  it("② result 是循环引用 ⇒ **不崩**，且降级成 String() 形态", () => {
    expect(() => render(<DefaultCard toolCall={tc({ result: circular("r") })} collapseDefault={false} />)).not.toThrow();
    expect(screen.getAllByText(/\[object Object\]/).length).toBeGreaterThan(0);
  });

  it("③ args 与 result **同时**是循环引用 ⇒ 仍不崩（两处回落各自独立生效）", () => {
    expect(() => render(
      <DefaultCard toolCall={tc({ args: { a: circular("x") }, result: circular("y") })} collapseDefault={false} />,
    )).not.toThrow();
  });

  it("④ 对照：可序列化的对象参数 ⇒ 正常显示 JSON（回落只在失败时生效）", () => {
    render(<DefaultCard toolCall={tc({ args: { path: "/tmp/x", n: 3 } })} collapseDefault={false} />);
    expect(screen.getByText(/\/tmp\/x/)).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/), "可序列化时不该走降级").toBeNull();
  });

  it("⑤ 对照：字符串结果原样显示（不经 JSON.stringify，也就不涉及回落）", () => {
    render(<DefaultCard toolCall={tc({ result: "纯文本结果" })} collapseDefault={false} />);
    expect(screen.getByText("纯文本结果")).toBeInTheDocument();
  });

  it("⑥ BigInt 结果（JSON.stringify 的另一类必抛输入）⇒ 不崩", () => {
    expect(() => render(<DefaultCard toolCall={tc({ result: { big: BigInt(10) } })} collapseDefault={false} />)).not.toThrow();
  });
});
