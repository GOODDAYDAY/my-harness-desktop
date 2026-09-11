// @vitest-environment jsdom
// EventFlow(事件流面板)的 DOM 断言 —— im-graph 插件此前**零渲染层测试**。
//   ① 每行渲染 时间 + 标签 + 文本
//   ② **时间按 HH:MM:SS 零填充** —— 用「本地时间构造」拿到与运行时时区无关的期望值
//      (9 时 5 分 3 秒 → "09:05:03";少一个 padStart 就变 "9:5:3",夜里看着像坏了)
//   ③ 标签文案取自**拼出来的 key** `im-graph.tag.<kind>` —— 前缀写错则所有标签都显示原始 key
//   ④ 标签 class 带 kind(`tag-<kind>`),便于按类型着色
//   ⑤ **streaming 追加 class** —— 正在打的字要能单独样式化(需求 §15 的"运行中要看得出来")
//   ⑥ 关闭按钮 → onClose()
//
// ⚠ 不测"自动滚到底":jsdom **无布局**,scrollHeight 恒为 0 → 断言 scrollTop === scrollHeight
//   会**永远通过**(典型的空转断言,见 §10.5 第 13/19 条)。该行为只能在真实浏览器里验(e2e)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => "T(" + k + ")" }) }));

import { EventFlow } from "./EventFlow";
import type { FlowEvent } from "../core/flow-events";

// 用本地时间构造 → 期望值不受时区影响
const at = (h: number, m: number, s: number): number => new Date(2026, 0, 2, h, m, s).getTime();
const ev = (over: Partial<FlowEvent> & { id: string }): FlowEvent =>
  ({ ts: at(12, 0, 0), kind: "tool", text: "hello", ...over }) as FlowEvent;

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll(".flow-item")) as HTMLElement[];

describe("EventFlow(事件流)", () => {
  it("① 每行渲染 时间 + 标签 + 文本", () => {
    render(<EventFlow title="Flow" events={[ev({ id: "e1", text: "跑工具" })]} onClose={() => {}} />);
    const r = rows()[0];
    expect(r.querySelector(".txt")?.textContent).toBe("跑工具");
    expect(r.querySelector(".ts")?.textContent).toBeTruthy();
    expect(r.querySelector(".tag")?.textContent).toBeTruthy();
  });

  it("② 时间 **HH:MM:SS 零填充**(9:5:3 → 09:05:03)", () => {
    render(<EventFlow title="Flow" events={[ev({ id: "e1", ts: at(9, 5, 3) })]} onClose={() => {}} />);
    expect(rows()[0].querySelector(".ts")?.textContent, "时间没有零填充").toBe("09:05:03");
  });

  it("②b 边界:午夜 00:00:00 也补齐两位", () => {
    render(<EventFlow title="Flow" events={[ev({ id: "e1", ts: at(0, 0, 0) })]} onClose={() => {}} />);
    expect(rows()[0].querySelector(".ts")?.textContent).toBe("00:00:00");
  });

  it("③ 标签文案取自拼出来的 key im-graph.tag.<kind>", () => {
    render(<EventFlow title="Flow" events={[ev({ id: "e1", kind: "message" })]} onClose={() => {}} />);
    expect(rows()[0].querySelector(".tag")?.textContent, "标签没走 im-graph.tag.<kind> 这套 key").toBe("T(im-graph.tag.message)");
  });

  it("④ 标签 class 带 kind", () => {
    render(<EventFlow title="Flow" events={[ev({ id: "e1", kind: "tool" })]} onClose={() => {}} />);
    expect(rows()[0].querySelector(".tag")?.className).toContain("tag-tool");
  });

  it("⑤ streaming 的行多一个 class,非 streaming 没有", () => {
    render(<EventFlow title="Flow" events={[
      ev({ id: "e1", text: "in flight", streaming: true }),
      ev({ id: "e2", text: "done" }),
    ]} onClose={() => {}} />);
    expect(rows()[0].querySelector(".txt")?.className, "流式行没有可样式的标记").toContain("streaming");
    expect(rows()[1].querySelector(".txt")?.className, "非流式行也被标成 streaming").not.toContain("streaming");
  });

  it("⑥ 关闭按钮 → onClose()", () => {
    const onClose = vi.fn();
    render(<EventFlow title="Flow" events={[]} onClose={onClose} />);
    fireEvent.click(document.querySelector(".flow-close")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
