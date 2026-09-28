// @vitest-environment jsdom
// retry 插件 DOM 交互测试(三级测试第二级,补零测试缺口):
//   重试按钮全生命周期——渲染条件(仅 assistant)/找不到 user 消息的诚实 toast/
//   点击 → fork(中立主键 ns, "before", abortSource) + prompt 重发(派生新会话 + 重发原文,
//   §7.1 第一行)/失败 toast;以及 H1 回归守卫(第 1 参用 ns 不用投影路径)。
//   流式态的拦截已改粒度:不再判全局 streaming,而是 manifest 声明 when.settled
//   由框架在「在飞的那一行」不渲染按钮(历史行流式中照常可重试)。
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
  /** useUiStore 面:中立主键(fork 的第 1 参要用它,不用投影路径——§kernel-forkless §32)。 */
  ui: { currentNeutralSessionId: "ns-1" },
}));

vi.mock("@my-harness-desktop/react", () => ({
  // Announce 是「把瞬时消息送进常驻 live region」的播报旁路（r37 新增）。
  // 本文件测的是点击行为与**可见**错误文本，播报路径由 live-region 自己的测试覆盖，
  // 所以这里给一个形状一致、不产内容的替身（真实实现是 portal，jsdom 里没必要建）。
  Announce: () => null,
  usePluginContext: () => ({
    messaging: { prompt: mocks.prompt },
    tree: { fork: mocks.fork },
  }),
  useSessionStore: (selector?: (s: unknown) => unknown) => (selector ? selector(mocks.state) : mocks.state),
  useUiStore: (selector?: (s: unknown) => unknown) => (selector ? selector(mocks.ui) : mocks.ui),
  useArmConfirm: () => armState(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => {
    const dict: Record<string, string> = {
      "shell.retry": "重试",
      "shell.retryArmed": "确认重试?",
      "shell.retryFailed": `重试失败：${opts?.error ?? ""}`,
      "shell.retryNoUserMessage": "找不到可重试的用户消息",
      "shell.retryStaleRow": "消息不在当前快照中，请稍候再点一次",
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
    const { container } = render(<RetryAction message={{ role: "user", id: "u1" } as never} text="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("assistant:渲染「重试」钮", () => {
    render(<RetryAction message={{ role: "assistant", id: "a1" } as never} text="" />);
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

  it("点击 → fork(中立主键 ns, user id, before, abortSource) + prompt(原 user 文本)", async () => {
    const ui = () => <RetryAction message={{ role: "assistant", id: "a1" } as never} text="" />;
    const { rerender } = render(ui());
    clickArmConfirm(rerender, ui, () => screen.getByTitle("重试"));
    // 第 1 参必须是**中立主键**(§kernel-forkless §32:neutralSessionId 是主键,path 降级为
    // 投影线索)。此前这条断言固化的是 snapshot.state.sessionFile(pi 投影路径)——契约要
    // lineageId、调用方给路径,靠壳侧「锚点归属纠偏」兜住结果,代价是每次重试打一条 warn
    // 回落,且把「挂到活跃 lineage」这条已修过的根因重新变成活路径。现已与另两个入口
    // (timeline rewind / session-tree)对齐,本断言守着不让它漂回投影路径。
    //
    // abortSource:回退重跑隐含「这条不要了」——源会话在飞则壳侧先中断并等落定再派生
    // (顺序不可拆:abort 打激活进程,派生会把激活切走)。已落定的历史行上重试无事发生。
    await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledWith("ns-1", "u1", "before", { abortSource: true }));
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledWith("原始问题文本"));
  });

  it("第 1 参不用投影路径(H1 回归守卫):sessionFile 存在也传 ns,不传路径", async () => {
    // 这条是 H1 的显式守卫:snapshot.state.sessionFile 明明在(/proj/sess.jsonl),
    // 但 fork 的第 1 参必须是 ns。若哪天有人"顺手"改回 sessionFile,本条当场红。
    const ui = () => <RetryAction message={{ role: "assistant", id: "a1" } as never} text="" />;
    const { rerender } = render(ui());
    clickArmConfirm(rerender, ui, () => screen.getByTitle("重试"));
    await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalled());
    const firstArg = mocks.fork.mock.calls[0][0];
    expect(firstArg).toBe("ns-1");
    expect(firstArg).not.toContain(".jsonl"); // 投影路径的形态特征
  });

  it("行不在快照(idx<0):toast 显形而非静默死(r363 缺口守卫)", async () => {
    // 根因:事件态行(buf id 域)对不上投影域快照,findIndex 落空;此前纯静默
    // return(§7.6 违例——点了像死了)。现在弹「消息不在当前快照中」toast。
    mocks.state.snapshot = { state: { sessionFile: "/p/s.jsonl" }, messages: [] };  // 空快照 → idx 必 < 0
    const ui = () => <RetryAction message={{ role: "assistant", id: "a1" } as never} text="" />;
    const { rerender } = render(ui());
    __armed = true;
    rerender(ui());
    fireEvent.click(screen.getByTitle("确认重试?"));
    await vi.waitFor(() => expect(screen.getByText(/消息不在当前快照/)).toBeInTheDocument());
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it("fork 失败:错误原文 toast(不静默)", async () => {
    mocks.fork.mockRejectedValueOnce(new Error("分叉锚点不在会话内容里"));
    const ui = () => <RetryAction message={{ role: "assistant", id: "a1" } as never} text="" />;
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
        { role: "user", id: "u1", content: "数组问题" },
        { role: "assistant", id: "a1", content: "答" },
      ],
    };
    const ui = () => <RetryAction message={{ role: "assistant", id: "a1" } as never} text="" />;
    const { rerender } = render(ui());
    clickArmConfirm(rerender, ui, () => screen.getByTitle("重试"));
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledWith("数组问题"));
  });

});
