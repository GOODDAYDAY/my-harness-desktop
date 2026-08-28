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
  onEventCb: null as ((e: SessionEvent) => void) | null,
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
  return {
    usePluginContext: () => ({ sessions, messaging }),
    useUiStore: (selector?: (s: { currentSessionPath: string | null }) => unknown) => {
      const state = { currentSessionPath: "/p/s.jsonl" };
      return selector ? selector(state) : state;
    },
  };
});

import { useGoalController } from "./goal-controller";

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
    mocks.onEventCb = null;
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

  it("用户停止(pause)后不再续跑,恢复(resume)后继续", () => {
    const { result } = renderHook(() => useGoalController());

    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "x" } });
    act(() => { result.current.pause(); });
    expect(result.current.goal?.phase).toBe("paused");

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(0); // 暂停不续跑

    act(() => { result.current.resume(); });
    expect(result.current.goal?.phase).toBe("active");

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 恢复后继续
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

    // 恢复:窗口刷新后目标从 custom.goal 读回
    expect(result.current.goal?.objective).toBe("持久化目标");
    expect(result.current.goal?.round).toBe(2);

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
});
