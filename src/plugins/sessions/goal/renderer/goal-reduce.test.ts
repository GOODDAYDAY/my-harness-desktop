import { describe, it, expect } from "vitest";
import type { SessionEvent } from "@my-harness-desktop/shared";
import { createGoal } from "../core/goal-state";
import {
  applyGoalEvent, renderContinuationPrompt, SET_GOAL_TOOL, ACHIEVE_GOAL_TOOL,
} from "./goal-reduce";

function toolCallStart(name: string, args?: unknown): SessionEvent {
  return { type: "toolCallStart", toolName: name, args } as SessionEvent;
}

describe("goal-reduce(纯归约,续跑引擎核心)", () => {
  it("set_goal → 建立 active 目标", () => {
    const r = applyGoalEvent(null, toolCallStart(SET_GOAL_TOOL, { objective: "写 README" }));
    expect(r.goal?.phase).toBe("active");
    expect(r.goal?.objective).toBe("写 README");
    expect(r.prompt).toBeUndefined();
  });

  it("achieve_goal → 标记 achieved", () => {
    const g = createGoal({ objective: "x" });
    const r = applyGoalEvent(g, toolCallStart(ACHIEVE_GOAL_TOOL));
    expect(r.goal?.phase).toBe("achieved");
    expect(r.prompt).toBeUndefined();
  });

  it("agentSettled 且 active → 注入续跑提示 + round+1", () => {
    const g = createGoal({ objective: "写 README", maxRounds: 3 });
    const r = applyGoalEvent(g, { type: "agentSettled" });
    expect(r.goal?.round).toBe(1);
    expect(r.prompt).toContain("写 README");
    expect(r.prompt).toContain("<goal_round>");
  });

  it("agentSettled 且 achieved → 不再续跑", () => {
    const g = createGoal({ objective: "x" });
    const achieved = applyGoalEvent(g, toolCallStart(ACHIEVE_GOAL_TOOL)).goal!;
    const r = applyGoalEvent(achieved, { type: "agentSettled" });
    expect(r.prompt).toBeUndefined();
  });

  it("agentSettled 且 paused → 不再续跑", () => {
    const g = { ...createGoal({ objective: "x" }), phase: "paused" as const };
    const r = applyGoalEvent(g, { type: "agentSettled" });
    expect(r.prompt).toBeUndefined();
  });

  it("畸形 set_goal 入参 → 静默忽略(状态不变)", () => {
    const r = applyGoalEvent(null, toolCallStart(SET_GOAL_TOOL, { objective: "   " }));
    expect(r.goal).toBeNull();
  });

  it("轮数上限:round 达到 maxRounds 后不再续跑", () => {
    const g = { ...createGoal({ objective: "x", maxRounds: 2 }), round: 2 };
    const r = applyGoalEvent(g, { type: "agentSettled" });
    expect(r.prompt).toBeUndefined();
  });

  it("renderContinuationPrompt 带 objective + 轮次", () => {
    const p = renderContinuationPrompt("目标A", 3, 8);
    expect(p).toContain("目标A");
    expect(p).toContain("Round: 3/8");
  });
});
