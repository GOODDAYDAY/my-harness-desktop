// @vitest-environment jsdom
// Markdown(会话流文本块)的 DOM 断言 —— 19 行的"流式特化壳",钉住它的**分支契约**:
//   `const content = streaming ? debouncedText : text;`
//   ① **非流式直接用原文**(不经过防抖)——历史消息不该被延迟
//   ② **流式用防抖后的值**——50ms 攒批,避免每个 token 都整块重渲
//   ③ 光标**只在流式时**渲染(StreamingCaret 是有意静态的,由它自己的设计文档决定;
//      这里守的是"该不该出现",不是"它动没动")
//
// 做法说明:用**哨兵值**代替真防抖——`useDebouncedValue` mock 成固定返回 "[debounced]",
// 于是"body 收到的是原文还是防抖值"一眼可断言,且不必和定时器打交道
// (假定时器与第三方库不同源是另一个坑,见 skills §10.5 第 11 条)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./stream-utils", () => ({
  useDebouncedValue: (_v: string, _ms: number) => "[debounced]",
  StreamingCaret: () => <span data-testid="caret" />,
}));
vi.mock("./markdown-body", () => ({
  MarkdownBody: ({ text }: { text: string }) => <div data-testid="body">{text}</div>,
}));

import { Markdown } from "./markdown";

const bodyText = (): string => screen.getByTestId("body").textContent!;

describe("Markdown(文本块:流式特化壳)", () => {
  it("① 非流式:body 收到**原文**,不经过防抖", () => {
    render(<Markdown text="历史消息原文" />);
    expect(bodyText(), "非流式被走了防抖分支(历史消息会被延迟)").toBe("历史消息原文");
  });

  it("② 流式:body 收到**防抖后的值**", () => {
    render(<Markdown text="正在打的字" streaming />);
    expect(bodyText(), "流式没有走防抖分支").toBe("[debounced]");
  });

  it("③ 光标只在流式时出现", () => {
    const { unmount } = render(<Markdown text="x" streaming />);
    expect(screen.getByTestId("caret")).toBeInTheDocument();
    unmount();

    render(<Markdown text="x" />);
    expect(screen.queryByTestId("caret"), "非流式也渲染了光标").toBeNull();
  });

  it("streaming 默认 false(不传即非流式)", () => {
    render(<Markdown text="abc" />);
    expect(bodyText()).toBe("abc");
    expect(screen.queryByTestId("caret")).toBeNull();
  });
});
