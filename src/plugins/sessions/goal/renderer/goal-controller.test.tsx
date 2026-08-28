// @vitest-environment jsdom
// goal 续跑引擎 e2e:useGoalController 全链路,证明 goal 能成功完成 + 跨刷新持久化。
// 模型 set_goal → 回合收敛续跑 → 模型 achieve_goal → 停止;并覆盖用户停止/恢复/编辑/关闭、
// 挂载恢复(从会话头行 custom.goal 读回)、变更落盘(写回 custom.goal)。
// mock 框架的 usePluginContext/useUiStore(只提供 onEvent/prompt/updateHeader/openSession 机制面),续跑逻辑全真跑。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
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
  // 稳定 API 对象:若每次 render 返回新对象,useGoalController 的 useEffect 依赖会每帧变化、无限重跑。
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

import { useGoalController, runGoalCommand } from "./goal-controller";

function emit(e: SessionEvent): void {
  act(() => { mocks.onEventCb?.(e); });
}

describe("goal 续跑引擎 e2e(useGoalController)", () => {
  beforeEach(() => {
    mocks.prompt.mockReset();
    mocks.prompt.mockResolvedValue(undefined);
    mocks.updateHeader.mockReset();
    mocks.updateHeader.mockResolvedValue(undefined);
    mocks.openSession.mockReset();
    mocks.openSession.mockResolvedValue(null); // 默认无既有目标
    mocks.notify.mockReset();
    mocks.notify.mockResolvedValue(undefined);
    mocks.eventsEmit.mockReset();
    mocks.onEventCb = null;
    mocks.pendingQueue = {};
  });

  it("set_goal → 续跑 → achieve_goal → 停止(完整闭环)", () => {
    const { result } = renderHook(() => useGoalController());

    // 模型调 set_goal → 建立 active 目标
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "写 README" } });
    expect(result.current.goal?.phase).toBe("active");
    expect(result.current.goal?.objective).toBe("写 README");

    // 回合收敛 → 注入续跑提示(与发送同源)
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("写 README");
    expect(mocks.prompt.mock.calls[0][0]).toContain("<goal_round>");

    // 模型调 achieve_goal → 标记达成
    emit({ type: "toolCallStart", toolName: "achieve_goal" });
    expect(result.current.goal?.phase).toBe("achieved");

    // 回合再收敛 → 不再续跑(证明完成即终止)
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
  });

  it("用户停止(pause)后不再续跑,恢复(resume)后继续", async () => {
    const { result } = renderHook(() => useGoalController());

    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "x" } });
    act(() => { result.current.pause(); });
    expect(result.current.goal?.phase).toBe("paused");

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(0); // 暂停不续跑

    // 恢复即「继续干活」:空闲时立即装第一轮(不等下一次回合收敛,否则 active 无人触发会停摆)。
    // 异步 act:flush 掉 prompt 的 finally 微任务(inflight 护栏复位),否则下一条事件被护栏挡住。
    await act(async () => { result.current.resume(); });
    expect(result.current.goal?.phase).toBe("active");
    expect(result.current.goal?.round).toBe(1);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("<goal_round>");

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(2); // 恢复后继续
  });

  it("编辑(edit)下次续跑生效,关闭(clear)后不再续跑", () => {
    const { result } = renderHook(() => useGoalController());

    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "旧目标" } });
    act(() => { result.current.edit("新目标"); });
    expect(result.current.goal?.objective).toBe("新目标");

    emit({ type: "agentSettled" });
    expect(mocks.prompt.mock.calls[0][0]).toContain("新目标"); // 下次续跑用新目标

    act(() => { result.current.clear(); });
    expect(result.current.goal).toBeNull();

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 清空后不再续跑
  });

  it("挂载时从会话头行恢复目标,变更时写回头行(跨刷新持久化)", async () => {
    mocks.openSession.mockResolvedValue({
      info: { custom: { goal: { objective: "持久化目标", phase: "active", round: 2, maxRounds: 8 } } },
    });
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await Promise.resolve(); });

    // 恢复:窗口刷新后目标从 custom.goal 读回;active 目标立即装弹续跑(2→3 轮),不因刷新停摆
    expect(result.current.goal?.objective).toBe("持久化目标");
    expect(result.current.goal?.round).toBe(3);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("Round: 3/8");

    // 变更写回:模型重新 set_goal → updateHeader 落 custom.goal
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "新目标" } });
    expect(mocks.updateHeader).toHaveBeenCalledWith(
      "/p/s.jsonl",
      { custom: { goal: expect.objectContaining({ objective: "新目标", phase: "active", round: 0 }) } },
    );
  });

  it("关闭(clear)落盘 goal=null 删键", () => {
    const { result } = renderHook(() => useGoalController());
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "x" } });
    act(() => { result.current.clear(); });
    expect(mocks.updateHeader).toHaveBeenLastCalledWith("/p/s.jsonl", { custom: { goal: null } });
  });

  // —— 用户 /goal 命令(人敲,与模型 set_goal 互补)——

  it("/goal <目标>:空闲设置 → 立即发首轮续跑 + 落盘(返回 true 吞掉发送)", async () => {
    const { result } = renderHook(() => useGoalController());

    let handled: boolean | undefined;
    await act(async () => { handled = await runGoalCommand("/goal 把测试全跑绿"); });

    expect(handled).toBe(true); // 吞掉发送,文本不进内核
    expect(result.current.goal?.objective).toBe("把测试全跑绿");
    expect(result.current.goal?.phase).toBe("active");
    expect(result.current.goal?.round).toBe(1); // 空闲即装弹:首轮立刻发
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("把测试全跑绿");
    expect(mocks.prompt.mock.calls[0][0]).toContain("Round: 1/256");
    expect(mocks.updateHeader).toHaveBeenCalledWith(
      "/p/s.jsonl",
      { custom: { goal: expect.objectContaining({ objective: "把测试全跑绿", round: 1 }) } },
    );

    // 首轮回合收敛 → 第二轮自然接续
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(mocks.prompt.mock.calls[1][0]).toContain("Round: 2/256");
  });

  it("/goal <目标>:忙时(回合在飞)不立即发,由在飞回合的 agentSettled 触发首轮", async () => {
    const { result } = renderHook(() => useGoalController());

    emit({ type: "agentStart" }); // 回合在飞
    await act(async () => { await runGoalCommand("/goal 忙时设置"); });

    expect(result.current.goal?.round).toBe(0); // 未装弹
    expect(mocks.prompt).toHaveBeenCalledTimes(0);

    emit({ type: "agentSettled" }); // 在飞回合收敛 → 首轮
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("Round: 1/256");
  });

  it("/goal stop·resume·edit·clear 子命令走同一状态机", async () => {
    const { result } = renderHook(() => useGoalController());

    await act(async () => { await runGoalCommand("/goal 原目标"); });
    expect(result.current.goal?.phase).toBe("active");

    await act(async () => { await runGoalCommand("/goal stop"); });
    expect(result.current.goal?.phase).toBe("paused");
    emit({ type: "agentSettled" });
    const callsAfterPause = mocks.prompt.mock.calls.length; // 暂停不续跑

    await act(async () => { await runGoalCommand("/goal edit 改过的目标"); });
    expect(result.current.goal?.objective).toBe("改过的目标");

    await act(async () => { await runGoalCommand("/goal resume"); });
    expect(result.current.goal?.phase).toBe("active");
    expect(mocks.prompt.mock.calls.length).toBe(callsAfterPause + 1); // 恢复即装弹

    await act(async () => { await runGoalCommand("/goal clear"); });
    expect(result.current.goal).toBeNull();
    expect(mocks.updateHeader).toHaveBeenLastCalledWith("/p/s.jsonl", { custom: { goal: null } });
  });

  it("裸 /goal 查看状态(通知);无目标时子命令提示而非崩溃(仍吞发送)", async () => {
    const { result } = renderHook(() => useGoalController());
    void result;

    let handled: boolean | undefined;
    await act(async () => { handled = await runGoalCommand("/goal"); });
    expect(handled).toBe(true);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0].body).toContain("/goal"); // 无目标 → 用法提示

    await act(async () => { handled = await runGoalCommand("/goal stop"); });
    expect(handled).toBe(true); // 无目标的 stop 也吞掉,不进内核
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it("已有目标时裸 /goal 回显当前状态", async () => {
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 状态回显目标"); });

    await act(async () => { await runGoalCommand("/goal"); });
    const last = mocks.notify.mock.calls[mocks.notify.mock.calls.length - 1][0];
    expect(last.body).toContain("状态回显目标");
    expect(last.body).toContain("active");
    void result;
  });

  it("非 /goal 文本放行(返回 false,照常发送)", async () => {
    renderHook(() => useGoalController());

    let handled: boolean | undefined;
    await act(async () => { handled = await runGoalCommand("普通消息"); });
    expect(handled).toBe(false);
    await act(async () => { handled = await runGoalCommand("/goalx 不是 goal 命令"); });
    expect(handled).toBe(false);
    expect(mocks.prompt).toHaveBeenCalledTimes(0);
  });

  it("goal:state 状态广播:生效=绿、暂停/清除=灭(消费方 timeline 着色依据)", async () => {
    renderHook(() => useGoalController());

    const states = (): ({ active: boolean } | undefined)[] =>
      mocks.eventsEmit.mock.calls.map((c) => c[1] as { active: boolean });

    await act(async () => { await runGoalCommand("/goal 广播目标"); });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { active: true });

    await act(async () => { await runGoalCommand("/goal stop"); });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { active: false });

    await act(async () => { await runGoalCommand("/goal resume"); });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { active: true });

    await act(async () => { await runGoalCommand("/goal clear"); });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { active: false });

    // 全程通道名不变,只翻 active 位
    expect(mocks.eventsEmit.mock.calls.every((c) => c[0] === "goal:state")).toBe(true);
    expect(states().length).toBe(4);
  });

  it("模型 set_goal / achieve_goal 也广播(工具路径与命令路径同收口)", () => {
    renderHook(() => useGoalController());

    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "工具设的目标" } });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { active: true });

    emit({ type: "toolCallStart", toolName: "achieve_goal" });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { active: false });
  });

  it("用户输入插队:收敛时有排队用户消息 → 本次不续跑不进轮次,队列清空后的收敛再续", async () => {
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 插队测试目标"); });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 设置即装首轮

    // 流式期用户排队了一条消息(经 timeline 入 ui-store.pendingQueue)
    mocks.pendingQueue = { s: [{ id: "u1" }] };
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 续跑让路,没抢发
    expect(result.current.goal?.round).toBe(1); // 轮次不空转

    // 用户消息发出、回合收敛、队列已清 → 续跑接上
    mocks.pendingQueue = {};
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(result.current.goal?.round).toBe(2);
    expect(mocks.prompt.mock.calls[1][0]).toContain("插队测试目标");
  });

  it("用户输入插队:排队未清时恢复也不即时装弹,等用户回合收敛再续", async () => {
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 恢复插队目标"); });
    await act(async () => { await runGoalCommand("/goal stop"); });
    const calls = mocks.prompt.mock.calls.length;

    mocks.pendingQueue = { s: [{ id: "u2" }] };
    await act(async () => { await runGoalCommand("/goal resume"); });
    expect(result.current.goal?.phase).toBe("active"); // 状态恢复
    expect(mocks.prompt).toHaveBeenCalledTimes(calls); // 但不抢发,让位排队用户输入

    mocks.pendingQueue = {};
    emit({ type: "agentSettled" }); // 用户消息的回合收敛
    expect(mocks.prompt).toHaveBeenCalledTimes(calls + 1); // 续跑此时才接上
  });
});
