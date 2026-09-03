import { describe, it, expect } from "vitest";
import {
  achieveGoal,
  createGoal,
  DEFAULT_MAX_GOAL_ROUNDS,
  editGoal,
  parseGoal,
  parseSetGoalArgs,
  pauseGoal,
  resumeGoal,
  setGoalMaxRounds,
  shouldContinue,
} from "./goal-state";

describe("goal 状态机(圆心纯函数)", () => {
  it("代码兜底上限是 1000(通用配置 goal.maxRounds 可覆盖,见 docs/design/goal.md §5.3)", () => {
    expect(DEFAULT_MAX_GOAL_ROUNDS).toBe(1000);
  });

  it("setGoalMaxRounds 只换上限:轮次/阶段/目标不动,到顶目标提高后 shouldContinue 重新成立", () => {
    const topped = { ...createGoal({ objective: "x", maxRounds: 2 }), round: 2 };
    expect(shouldContinue(topped)).toBe(false); // 到顶停摆
    const raised = setGoalMaxRounds(topped, 5);
    expect(raised.maxRounds).toBe(5);
    expect(raised.round).toBe(2); // 轮次不回滚
    expect(raised.phase).toBe("active"); // 阶段不动
    expect(raised.objective).toBe("x");
    expect(shouldContinue(raised)).toBe(true); // 提高上限 → 恢复续跑资格
  });

  it("setGoalMaxRounds 拒绝非正整数", () => {
    const g = createGoal({ objective: "x" });
    expect(() => setGoalMaxRounds(g, 0)).toThrow();
    expect(() => setGoalMaxRounds(g, -3)).toThrow();
    expect(() => setGoalMaxRounds(g, 1.5)).toThrow();
  });

  it("create 产出 active + round=0 + 默认 maxRounds", () => {
    const g = createGoal({ objective: "重构 auth 模块" });
    expect(g.phase).toBe("active");
    expect(g.round).toBe(0);
    expect(g.maxRounds).toBe(DEFAULT_MAX_GOAL_ROUNDS);
    expect(g.objective).toBe("重构 auth 模块");
  });

  it("create 规范化 objective(trim)", () => {
    const g = createGoal({ objective: "  写个东西  " });
    expect(g.objective).toBe("写个东西");
  });

  it("create 拒绝空 objective", () => {
    expect(() => createGoal({ objective: "   " })).toThrow();
  });

  it("create 拒绝非法 maxRounds(非正整数)", () => {
    expect(() => createGoal({ objective: "x", maxRounds: 0 })).toThrow();
    expect(() => createGoal({ objective: "x", maxRounds: -1 })).toThrow();
    expect(() => createGoal({ objective: "x", maxRounds: 1.5 })).toThrow();
  });

  it("achieve 把 active → achieved", () => {
    const g = achieveGoal(createGoal({ objective: "x" }));
    expect(g.phase).toBe("achieved");
  });

  it("achieve 幂等(已 achieved 不抛、不重复推进)", () => {
    const g1 = achieveGoal(createGoal({ objective: "x" }));
    const g2 = achieveGoal(g1);
    expect(g2).toEqual(g1);
  });

  it("shouldContinue:active 且未达上限才续跑", () => {
    const active = createGoal({ objective: "x", maxRounds: 2 });    expect(shouldContinue(active)).toBe(true);
    expect(shouldContinue({ ...active, round: 1 })).toBe(true);
    expect(shouldContinue({ ...active, round: 2 })).toBe(false); // 达上限
    expect(shouldContinue(achieveGoal(active))).toBe(false); // 已达成
    expect(shouldContinue(pauseGoal(active))).toBe(false); // 已暂停
  });

  it("pause:active → paused(幂等);resume:paused → active(幂等)", () => {
    const active = createGoal({ objective: "x" });
    const paused = pauseGoal(active);
    expect(paused.phase).toBe("paused");
    expect(pauseGoal(paused)).toEqual(paused); // 非 active 幂等
    expect(resumeGoal(paused).phase).toBe("active");
    expect(resumeGoal(active)).toEqual(active); // 非 paused 幂等
  });

  it("edit 只换 objective,阶段/轮数/上限不变;空 objective 拒绝", () => {
    const g = createGoal({ objective: "x", maxRounds: 5 });
    const edited = editGoal({ ...g, round: 2 }, "新目标");
    expect(edited.objective).toBe("新目标");
    expect(edited.phase).toBe("active");
    expect(edited.round).toBe(2);
    expect(edited.maxRounds).toBe(5);
    expect(() => editGoal(g, "  ")).toThrow();
  });

  it("parseSetGoalArgs 解析客观 objective/max_rounds,畸形返回 null", () => {
    expect(parseSetGoalArgs({ objective: "  x  " })).toEqual({ objective: "x" });
    expect(parseSetGoalArgs({ objective: "x", max_rounds: 3 })).toEqual({ objective: "x", maxRounds: 3 });
    expect(parseSetGoalArgs({ objective: "" })).toBeNull();
    expect(parseSetGoalArgs({ objective: "x", max_rounds: 0 })).toBeNull();
    expect(parseSetGoalArgs(null)).toBeNull();
    expect(parseSetGoalArgs("not-object")).toBeNull();
  });

  it("parseGoal 从头行 custom.goal 读回校验,畸形返回 null", () => {
    expect(parseGoal({ objective: "x", phase: "active", round: 2, maxRounds: 8 }))
      .toEqual({ objective: "x", phase: "active", round: 2, maxRounds: 8 });
    expect(parseGoal({ objective: "x", phase: "paused", round: 0, maxRounds: 3 })?.phase).toBe("paused");
    expect(parseGoal({ objective: "", phase: "active", round: 0, maxRounds: 8 })).toBeNull();
    expect(parseGoal({ objective: "x", phase: "bogus", round: 0, maxRounds: 8 })).toBeNull();
    expect(parseGoal({ objective: "x", phase: "active", round: -1, maxRounds: 8 })).toBeNull();
    expect(parseGoal({ objective: "x", phase: "active", round: 0, maxRounds: 0 })).toBeNull();
    expect(parseGoal(null)).toBeNull();
    expect(parseGoal("not-object")).toBeNull();
  });
});
