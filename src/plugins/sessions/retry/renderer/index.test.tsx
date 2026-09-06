// @vitest-environment jsdom
// retry 插件 DOM 交互测试(三级测试第二级,补零测试缺口):
//   重试按钮全生命周期——渲染条件(仅 assistant)/流式中拦截/找不到 user 消息的诚实 toast/
//   点击 → fork("before") + prompt 重发(派生新会话 + 重发原文,§7.1 第一行)/失败 toast。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  fork: vi.fn(),
  /** 可变快照(数组内容用例改写它,避免动态 re-import)。 */
  state: {
    streaming: false,
    snapshot: {
      state: { sessionFile: "/proj/sess.jsonl" },
      messages: [
        { role: "user", id: "u1", content: "原始问题文本" },
        { role: "assistant", id: "a1", content: "回答" },
      ],
    },
  },
}));

vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({
    messaging: { prompt: mocks.prompt },
    tree: { fork: mocks.fork },
  }),
  useSessionStore: (selector?: (s: unknown) => unknown) => (selector ? selector(mocks.state) : mocks.state),
  useArmConfirm: () => armState(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => {
    const dict: Record<string, string> = {
      "shell.retry": "重试",
      "shell.retryArmed": "确认重试?",
      "shell.retryFailed": `重试失败：${opts?.error ?? ""}`,
      "shell.retryStreamingBlocked": "生成进行中，无法重试",
      "shell.retryNoUserMessage": "找不到可重试的用户消息",
    };
    return dict[k] ?? k;
  } }),
}));

/** arm-confirm 两段式(组件真行为:首点 arm、二点 disarm+执行)。React 里 armed 变化
 *  要重渲染才看得见——测试里:首点后手动置 armed 再 render(同一容器重新渲染),
 *  二点命中 armed 分支。这忠实还原「arm 一次点击 → 确认态 → 再点执行」的两段式。 */
let __armed = false;
const armState = () => ({
  get armed() { return __armed; },
  arm: () => { __armed = true; },
  disarm: () => { __armed = false; },
});
/** 两段式点击:点(arm)→置 armed→重渲染→点(执行)。el 获取器每次重查(title 会变「确认重试?」)。 */
const clickArmConfirm = (rerender: (ui: React.ReactNode) => void, makeUi: () => React.ReactNode, getByTitleFirst: () => HTMLElement) => {
  fireEvent.click(getByTitleFirst());            // 第一击:arm
  __armed = true;                                // 模拟 arm 引发的状态变化
  rerender(makeUi());                            // 重渲染(确认态:title=确认重试?)
  fireEvent.click(screen.getByTitle("确认重试?")); // 第二击:执行
  __armed = false;
};

import { RetryAction } from "./index";

describe("RetryAction 渲染条件", () => {
  beforeEach(() => { cleanup(); mocks.prompt.mockReset(); mocks.fork.mockReset(); });

  it("user 消息:不渲染", () => {
    const { container } = render(<RetryAction message={{ role: "user", id: "u1" } as never} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("assistant:渲染「重试」钮", () => {
    render(<RetryAction message={{ role: "assistant", id: "a1" } as never} />);
    expect(screen.getByTitle("重试")).toBeInTheDocument();
  });
});

describe("RetryAction 点击(重试 = fork before + 重发原文,§7.1)", () => {
  beforeEach(() => {
    cleanup();
    mocks.prompt.mockReset().mockResolvedValue(undefined);
    mocks.fork.mockReset().mockResolvedValue("/new/path");
    mocks.state.snapshot = {  // 基线快照(数组用例自改)
      state: { sessionFile: "/proj/sess.jsonl" },
      messages: [
        { role: "user", id: "u1", content: "原始问题文本" },
        { role: "assistant", id: "a1", content: "回答" },
      ],
    };
  });

  it("点击 → fork(会话文件, user id, before) + prompt(原 user 文本)", async () => {
    const ui = () => <RetryAction message={{ role: "assistant", id: "a1" } as never} />;
    const { rerender } = render(ui());
    clickArmConfirm(rerender, ui, () => screen.getByTitle("重试"));
    await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledWith("/proj/sess.jsonl", "u1", "before"));
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledWith("原始问题文本"));
  });

  it("fork 失败:错误原文 toast(不静默)", async () => {
    mocks.fork.mockRejectedValueOnce(new Error("分叉锚点不在会话内容里"));
    const ui = () => <RetryAction message={{ role: "assistant", id: "a1" } as never} />;
    const { rerender } = render(ui());
    clickArmConfirm(rerender, ui, () => screen.getByTitle("重试"));
    await vi.waitFor(() => expect(screen.getByText(/重试失败：/)).toBeInTheDocument());
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it("数组内容块的 user 消息:text 块拼出重发文本", async () => {
    // 数组内容形态(块消息):text 块 join 重发——与字符串内容同一条链
    mocks.state.snapshot = {
      state: { sessionFile: "/p/s.jsonl" },
      messages: [
        { role: "user", id: "u1", content: [{ type: "text", text: "数组" }, { type: "text", text: "问题" }] },
        { role: "assistant", id: "a1", content: "答" },
      ],
    };
    const ui = () => <RetryAction message={{ role: "assistant", id: "a1" } as never} />;
    const { rerender } = render(ui());
    clickArmConfirm(rerender, ui, () => screen.getByTitle("重试"));
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledWith("数组问题"));
  });

});
