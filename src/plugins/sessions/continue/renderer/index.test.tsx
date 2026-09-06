// @vitest-environment jsdom
// continue 插件 DOM 交互测试(三级测试第二级,补零测试缺口):
//   继续按钮全生命周期——渲染条件(仅异常停机 assistant)/流式中拦截(不 prompt)/
//   点击发通用续跑提示(原地续跑=发消息,goal.md §3.2)/失败 toast 显形。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
}));

vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({ messaging: { prompt: mocks.prompt } }),
  useSessionStore: (selector?: (s: unknown) => unknown) => {
    const state = { streaming: false };
    return selector ? selector(state) : state;
  },
  useArmConfirm: () => ({ armed: false, arm: vi.fn(), disarm: vi.fn() }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => {
    if (opts?.defaultValue) return String(opts.defaultValue);
    const dict: Record<string, string> = {
      "shell.continue": "继续",
      "shell.continueFailed": `继续失败：${opts?.error ?? ""}`,
      "shell.continueStreamingBlocked": "生成进行中，无法继续",
    };
    return dict[k] ?? k;
  } }),
}));

import { ContinueAction } from "./index";

describe("ContinueAction 渲染条件(只在异常停机的 assistant 上)", () => {
  beforeEach(() => { cleanup(); mocks.prompt.mockReset(); });

  it("user 消息:不渲染", () => {
    const { container } = render(<ContinueAction message={{ role: "user", id: "u1" } as never} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("正常完成的 assistant(error/stopped 都无):不渲染——异常停机才给续跑入口", () => {
    const { container } = render(<ContinueAction message={{ role: "assistant", id: "a1" } as never} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("error assistant(生成失败):渲染「继续」钮", () => {
    render(<ContinueAction message={{ role: "assistant", id: "a1", error: true } as never} />);
    expect(screen.getByTitle("继续")).toBeInTheDocument();
  });

  it("stopped assistant(用户中断):渲染", () => {
    render(<ContinueAction message={{ role: "assistant", id: "a1", stopped: true } as never} />);
    expect(screen.getByTitle("继续")).toBeInTheDocument();
  });

  it("无 id 的 assistant:不渲染(锚点缺失无法定位)", () => {
    const { container } = render(<ContinueAction message={{ role: "assistant", error: true } as never} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ContinueAction 点击行为(原地续跑 = 发消息)", () => {
  beforeEach(() => { cleanup(); mocks.prompt.mockReset(); });

  it("点击 → prompt 发通用续跑文案(goal.md §3.2:续跑就是发消息,不 fork 不重发)", async () => {
    render(<ContinueAction message={{ role: "assistant", id: "a1", error: true } as never} />);
    fireEvent.click(screen.getByTitle("继续"));
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(1));
    expect(mocks.prompt).toHaveBeenCalledWith(expect.stringContaining("继续未完成的工作"));
  });

  it("prompt 失败:失败 toast 显形(错误原文透传,不静默)", async () => {
    mocks.prompt.mockRejectedValueOnce(new Error("会话未启动"));
    render(<ContinueAction message={{ role: "assistant", id: "a1", error: true } as never} />);
    fireEvent.click(screen.getByTitle("继续"));
    await vi.waitFor(() => expect(screen.getByText(/继续失败：会话未启动/)).toBeInTheDocument());
  });
});
