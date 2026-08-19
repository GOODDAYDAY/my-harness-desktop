import { describe, it, expect } from "vitest";
import { applyGoalOperation, GoalError, type GoalSnapshot } from "./goal-fold";

const T = 1_000;

function create(objective = "重构 auth 模块", maxGoalRounds = 8): GoalSnapshot {
  return applyGoalOperation(null, "create", { objective, maxGoalRounds }, T);
}

describe("goal-fold applyGoalOperation", () => {
  it("create 产出 revision=1 + active + roundsStarted=0", () => {
    const g = create();
    expect(g.revision).toBe(1);
    expect(g.phase).toBe("active");
    expect(g.roundsStarted).toBe(0);
    expect(g.objective).toBe("重构 auth 模块");
  });

  it("已有活跃 goal 时 create 拒绝", () => {
    const g = create();
    expect(() => applyGoalOperation(g, "create", { objective: "再来一个" }, T + 1))
      .toThrowError(GoalError);
  });

  it("pause: active → paused", () => {
    const g = applyGoalOperation(create(), "pause", {}, T + 1);
    expect(g.phase).toBe("paused");
    expect(g.revision).toBe(2);
  });

  it("resume: paused → active", () => {
    const paused = applyGoalOperation(create(), "pause", {}, T + 1);
    const g = applyGoalOperation(paused, "resume", {}, T + 2);
    expect(g.phase).toBe("active");
  });

  it("complete: active → complete", () => {
    const g = applyGoalOperation(create(), "complete", {}, T + 1);
    expect(g.phase).toBe("complete");
  });

  it("block: active → blocked 带 reason", () => {
    const g = applyGoalOperation(create(), "block", { blockedReason: { code: "model-reported", message: "卡住了" } }, T + 1);
    expect(g.phase).toBe("blocked");
    expect(g.blockedReason?.code).toBe("model-reported");
  });

  it("edit 改 objective、保持 phase/revision+1", () => {
    const g = applyGoalOperation(create(), "edit", { objective: "重构完了" }, T + 1);
    expect(g.objective).toBe("重构完了");
    expect(g.phase).toBe("active");
    expect(g.revision).toBe(2);
  });

  it("非法转移：pause 从 paused 拒绝", () => {
    const paused = applyGoalOperation(create(), "pause", {}, T + 1);
    expect(() => applyGoalOperation(paused, "pause", {}, T + 2)).toThrowError(GoalError);
  });

  it("block 无 reason 拒绝", () => {
    expect(() => applyGoalOperation(create(), "block", {}, T + 1)).toThrowError(GoalError);
  });

  it("revision 严格 +1（连续）", () => {
    const g1 = create();
    const g2 = applyGoalOperation(g1, "edit", { objective: "b" }, T + 1);
    const g3 = applyGoalOperation(g2, "edit", { objective: "c" }, T + 2);
    expect(g3.revision).toBe(3);
  });
});
