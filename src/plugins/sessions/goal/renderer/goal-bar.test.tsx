// @vitest-environment jsdom
// GoalBar DOM e2e —— 真实渲染 + 真实 DOM 交互,覆盖用户视角的完整闭环:
// 人敲 /goal 设置(经 composerCommands 机制入口 runGoalCommand)→ 目标条出现 →
// 点按钮停止/恢复/编辑/关闭(删改停)→ 状态与续跑副作用逐条对账。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { SessionEvent } from "@my-harness-desktop/shared";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  updateHeader: vi.fn(),
  openSession: vi.fn(),
  notify: vi.fn(),
  eventsEmit: vi.fn(),
  onEventCb: null as ((e: SessionEvent) => void) | null,
  pendingQueue: {} as Record<string, { id: string }[]>,
}));

vi.mock("@my-harness-desktop/react", () => {
  // 稳定 API 对象(同 goal-controller.test.tsx 纪律)。
  const sessions = {
    onEvent: (cb: (e: SessionEvent) => void) => {
      mocks.onEventCb = cb;
      return () => { mocks.onEventCb = null; };
    },
    updateHeader: mocks.updateHeader,
    openSession: mocks.openSession,
  };
  const messaging = { prompt: mocks.prompt };
  const notify = { show: mocks.notify };
  const events = { emit: mocks.eventsEmit, on: vi.fn(() => () => {}) };
  const stateOf = (): { currentSessionPath: string; pendingQueue: Record<string, { id: string }[]> } =>
    ({ currentSessionPath: "/p/s.jsonl", pendingQueue: mocks.pendingQueue });
  const useUiStore = Object.assign(
    (selector?: (s: ReturnType<typeof stateOf>) => unknown) => (selector ? selector(stateOf()) : stateOf()),
    { getState: stateOf },
  );
  return {
    usePluginContext: () => ({ sessions, messaging, notify, events }),
    useUiStore,
  };
});

import { GoalBar } from "./goal-bar";
import { runGoalCommand } from "./goal-controller";

function emit(e: SessionEvent): void {
  act(() => { mocks.onEventCb?.(e); });
}

describe("GoalBar DOM e2e(设置 + 删改停)", () => {
  beforeEach(() => {
    mocks.prompt.mockReset();
    mocks.prompt.mockResolvedValue(undefined);
    mocks.updateHeader.mockReset();
    mocks.updateHeader.mockResolvedValue(undefined);
    mocks.openSession.mockReset();
    mocks.openSession.mockResolvedValue(null);
    mocks.notify.mockReset();
    mocks.notify.mockResolvedValue(undefined);
    mocks.eventsEmit.mockReset();
    mocks.onEventCb = null;
    mocks.pendingQueue = {};
  });

  it("无目标不渲染;人敲 /goal → 目标条出现且首轮续跑已发出", async () => {
    const { container } = render(<GoalBar />);
    expect(container.firstChild).toBeNull();

    // composerCommands 机制入口:与 timeline 发送拦截调用的是同一个函数
    await act(async () => {
      const handled = await runGoalCommand("/goal 把 e2e 测试补齐");
      expect(handled).toBe(true);
    });

    expect(screen.getByText("把 e2e 测试补齐")).toBeInTheDocument();
    expect(screen.getByText("1/256")).toBeInTheDocument(); // 空闲设置即装弹:首轮已发
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    // active 态视觉:成功色左边框 + 停止按钮在位(内联样式含 var() 原样断言,不依赖 jsdom 解析变量)
    expect(container.firstElementChild?.getAttribute("style")).toContain("var(--color-accent-success)");
    expect(screen.getByTitle("停止")).toBeInTheDocument();
    // 横幅身份锚点(e2e 定位用)+ 相位数据属性
    expect(container.querySelector("[data-goal-bar]")).not.toBeNull();
    expect(container.querySelector('[data-goal-phase="active"]')).not.toBeNull();
  });

  it("停止(删改停之「停」):点按钮 → paused 态,回合收敛不再续跑", async () => {
    const { container } = render(<GoalBar />);
    await act(async () => { await runGoalCommand("/goal 停下来的目标"); });
    const promptCalls = mocks.prompt.mock.calls.length; // 设置时的首轮

    // DOM 点击停止
    fireEvent.click(screen.getByTitle("停止"));

    expect(screen.getByTitle("恢复")).toBeInTheDocument(); // 按钮翻转为恢复
    // paused 态视觉:警告色左边框(active 时是成功色)
    expect(container.firstElementChild?.getAttribute("style")).toContain("var(--color-accent-warning)");
    expect(container.querySelector('[data-goal-phase="paused"]')).not.toBeNull();
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(promptCalls); // 暂停不续跑
  });

  it("恢复:点按钮 → 立即补发一轮续跑(DOM 上见新轮次)", async () => {
    render(<GoalBar />);
    await act(async () => { await runGoalCommand("/goal 恢复测试"); });

    fireEvent.click(screen.getByTitle("停止"));
    expect(screen.getByTitle("恢复")).toBeInTheDocument();

    // DOM 点击恢复:空闲即装弹,不用等下一次回合收敛
    await act(async () => { fireEvent.click(screen.getByTitle("恢复")); });
    expect(mocks.prompt).toHaveBeenCalledTimes(2); // 首轮 + 恢复轮
    expect(screen.getByText("2/256")).toBeInTheDocument();
  });

  it("编辑(删改停之「改」):点轮次 → 出现输入框 → 键入新目标回车 → 下次续跑用新目标", async () => {
    render(<GoalBar />);
    await act(async () => { await runGoalCommand("/goal 旧目标"); });

    // DOM 点击轮次按钮(编辑入口)→ 输入框出现,placeholder 为当前目标
    fireEvent.click(screen.getByTitle("编辑目标"));
    const input = screen.getByPlaceholderText("旧目标");
    expect(input).toBeInTheDocument();

    // 键入新目标 + 回车提交
    fireEvent.change(input, { target: { value: "改过的新目标" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("改过的新目标")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("旧目标")).not.toBeInTheDocument();

    // 下次续跑提示用新目标
    emit({ type: "agentSettled" });
    const last = mocks.prompt.mock.calls[mocks.prompt.mock.calls.length - 1][0];
    expect(last).toContain("改过的新目标");
  });

  it("编辑:Escape 取消,目标不变", async () => {
    render(<GoalBar />);
    await act(async () => { await runGoalCommand("/goal 不改动目标"); });

    fireEvent.click(screen.getByTitle("编辑目标"));
    const input = screen.getByPlaceholderText("不改动目标");
    fireEvent.change(input, { target: { value: "白打一场" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.getByText("不改动目标")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("白打一场")).not.toBeInTheDocument();
  });

  it("关闭(删改停之「删」):点垃圾桶 → 目标条从 DOM 消失 + 头行落 null 删键", async () => {
    const { container } = render(<GoalBar />);
    await act(async () => { await runGoalCommand("/goal 待删除目标"); });
    expect(container.firstElementChild).not.toBeNull();

    fireEvent.click(screen.getByTitle("关闭目标"));

    expect(container.firstChild).toBeNull(); // DOM 消失
    expect(mocks.updateHeader).toHaveBeenLastCalledWith("/p/s.jsonl", { custom: { goal: null } });

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 关闭后只剩设置时的首轮,不再续跑
  });

  it("模型 set_goal 与用户 /goal 同状态机:工具设置的目标一样能删改停", async () => {
    render(<GoalBar />);

    // 模型路径:中性事件 toolCallStart
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "模型设的目标" } });
    expect(screen.getByText("模型设的目标")).toBeInTheDocument();

    // 用户路径删改停照样生效
    fireEvent.click(screen.getByTitle("编辑目标"));
    fireEvent.change(screen.getByPlaceholderText("模型设的目标"), { target: { value: "用户改的" } });
    fireEvent.keyDown(screen.getByPlaceholderText("模型设的目标"), { key: "Enter" });
    expect(screen.getByText("用户改的")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("停止"));
    expect(screen.getByTitle("恢复")).toBeInTheDocument();
  });
});
