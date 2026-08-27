// @vitest-environment jsdom
// goal 续跑引擎 e2e:useGoalController 全链路,证明 goal 能成功完成。
// 模型 set_goal → 回合收敛续跑 → 模型 achieve_goal → 停止;并覆盖用户停止/恢复/编辑/关闭。
// mock 框架的 usePluginContext(只提供 onEvent 订阅 + prompt 发消息两个机制面),续跑逻辑全真跑。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SessionEvent } from "@my-harness-desktop/shared";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  onEventCb: null as ((e: SessionEvent) => void) | null,
}));

vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({
    sessions: {
      onEvent: (cb: (e: SessionEvent) => void) => {
        mocks.onEventCb = cb;
        return () => { mocks.onEventCb = null; };
      },
    },
    messaging: { prompt: mocks.prompt },
  }),
}));

import { useGoalController } from "./goal-controller";

function emit(e: SessionEvent): void {
  act(() => { mocks.onEventCb?.(e); });
}

describe("goal 续跑引擎 e2e(useGoalController)", () => {
  beforeEach(() => {
    mocks.prompt.mockReset();
    mocks.prompt.mockResolvedValue(undefined);
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
});
