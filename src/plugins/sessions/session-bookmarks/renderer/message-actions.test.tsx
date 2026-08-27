// @vitest-environment jsdom
// DOM 测试:ForkAction/BookmarkAction 渲染 + 交互(§bookmark-snapshot-fork-unify §6)。
// mock 框架 hooks(usePluginContext/useUiStore/useSessionStore/useArmConfirm)与 react-i18next,
// 只验证组件自身行为:渲染条件、点击 invoke 通道、分叉武装确认。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  forkFromSession: vi.fn(),
  arm: vi.fn(),
  disarm: vi.fn(),
}));

vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({
    events: { invoke: mocks.invoke },
    pi: { forkFromSession: mocks.forkFromSession },
  }),
  useUiStore: () => ({ currentCwd: "/p", currentSessionPath: "/p/s.jsonl", currentNeutralSessionId: "ns" }),
  useSessionStore: (selector?: (s: unknown) => unknown) => {
    const state = { snapshot: { state: { sessionName: "会话" } }, streaming: false };
    return selector ? selector(state) : state;
  },
  useArmConfirm: () => ({ armed: false, arm: mocks.arm, disarm: mocks.disarm }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh-CN" } }),
}));

import { BookmarkAction, ForkAction } from "./message-actions";

describe("BookmarkAction", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("assistant 消息渲染收藏按钮,点击 invoke bookmarks:addRequested 带 entryId/sessionPath", () => {
    render(<BookmarkAction message={{ role: "assistant", id: "k1" }} text="hello world" />);
    const btn = screen.getByTitle("shell.bookmark");
    fireEvent.click(btn);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "bookmarks:addRequested",
      expect.objectContaining({ entryId: "k1", sessionPath: "/p/s.jsonl" }),
    );
  });

  it("非 assistant 消息不渲染(返回 null)", () => {
    const { container } = render(<BookmarkAction message={{ role: "user", id: "k1" }} text="hi" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ForkAction", () => {
  beforeEach(() => {
    mocks.arm.mockReset();
    mocks.forkFromSession.mockReset();
  });

  it("assistant 消息渲染分叉按钮;首次点击进入武装确认(不立即 fork)", () => {
    render(<ForkAction message={{ role: "assistant", id: "k1" }} text="answer" />);
    fireEvent.click(screen.getByTitle("shell.fork"));
    expect(mocks.arm).toHaveBeenCalledWith(true);
    expect(mocks.forkFromSession).not.toHaveBeenCalled();
  });

  it("非 assistant 消息不渲染(返回 null)", () => {
    const { container } = render(<ForkAction message={{ role: "user", id: "k1" }} text="hi" />);
    expect(container).toBeEmptyDOMElement();
  });
});
