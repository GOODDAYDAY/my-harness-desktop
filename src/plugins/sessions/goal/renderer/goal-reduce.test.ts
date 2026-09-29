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

  // —— set_goal 幂等编辑语义(根因修复回归:已有目标的 set_goal 不再 createGoal 重置)——

  it("已有 active 目标时再收 set_goal:收敛为「改」——保轮次/阶段,换 objective", () => {
    const g = { ...createGoal({ objective: "旧目标", maxRounds: 256 }), round: 5 };
    const r = applyGoalEvent(g, toolCallStart(SET_GOAL_TOOL, { objective: "新目标" }));
    expect(r.goal?.objective).toBe("新目标");
    expect(r.goal?.round).toBe(5); // 轮次不归零(旧实现 createGoal 重置 round=0)
    expect(r.goal?.phase).toBe("active");
    expect(r.goal?.maxRounds).toBe(256); // 未显式给 max_rounds 不动上限
  });

  it("已有目标 + set_goal 显式带 max_rounds:采纳新上限(保轮次)", () => {
    const g = { ...createGoal({ objective: "旧目标" }), round: 5 };
    const r = applyGoalEvent(g, toolCallStart(SET_GOAL_TOOL, { objective: "新目标", max_rounds: 10 }));
    expect(r.goal?.maxRounds).toBe(10);
    expect(r.goal?.round).toBe(5);
  });

  it("paused 目标收到 set_goal:按「改」处理,阶段不被掀回 active", () => {
    const g = { ...createGoal({ objective: "旧目标" }), phase: "paused" as const, round: 2 };
    const r = applyGoalEvent(g, toolCallStart(SET_GOAL_TOOL, { objective: "新目标" }));
    expect(r.goal?.phase).toBe("paused");
    expect(r.goal?.objective).toBe("新目标");
  });

  it("achieved 后模型再 set_goal:正常新建(新目标新轮次)", () => {
    const g = { ...createGoal({ objective: "旧目标" }), phase: "achieved" as const, round: 9 };
    const r = applyGoalEvent(g, toolCallStart(SET_GOAL_TOOL, { objective: "全新目标" }));
    expect(r.goal?.objective).toBe("全新目标");
    expect(r.goal?.round).toBe(0);
    expect(r.goal?.phase).toBe("active");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyGoalEvent 的 catch 回落（r174；r173 用覆盖率确证 goal-reduce.ts:63 从未被执行）
//
// 那条 catch 是 `catch { return { goal: state }; }` —— 构造/编辑目标抛错时**保持原状态**
// （不清空、不半改）。可达路径实测有一条：`opts.defaultMaxRounds` 来自用户配置
// （goal.maxRounds），而 `parseSetGoalArgs` **只校验模型给的 max_rounds、不校验这个默认值**
// ⇒ 配置写成 0 / 负数 / 小数时 `createGoal` 会抛（"maxRounds must be a positive safe integer"）。
//
// ⚠ 这条路径的意义：配置是用户手改的东西，坏值不该让归约器崩、也不该建出一个
//   maxRounds 非法的半个目标（那会让续跑引擎立刻判定"已达上限"或永不续跑）。
// ─────────────────────────────────────────────────────────────────────────────
describe("applyGoalEvent：createGoal/editGoal 抛错时的 catch 回落（保持原状态）", () => {
  it("① 无目标 + **坏的 defaultMaxRounds**（用户配置写了 0）⇒ 抛错被兜住、goal 保持 null", () => {
    const out = applyGoalEvent(null, toolCallStart(SET_GOAL_TOOL, { objective: "做点事" }), { defaultMaxRounds: 0 });
    expect(out.goal, "配置坏值不该建出半个目标（maxRounds 非法会让续跑引擎误判）").toBeNull();
    expect(out.prompt, "失败时不该给出续跑提示").toBeUndefined();
  });

  it("② 无目标 + defaultMaxRounds 为负数 / 小数 ⇒ 同样兜住（正整数校验的两侧）", () => {
    for (const bad of [-5, 1.5, Number.NaN]) {
      const out = applyGoalEvent(null, toolCallStart(SET_GOAL_TOOL, { objective: "x" }), { defaultMaxRounds: bad });
      expect(out.goal, `defaultMaxRounds=${bad} 应被兜住`).toBeNull();
    }
  });

  it("③ **已有进行中目标** + 坏的 defaultMaxRounds ⇒ 保持**原目标不变**（不清空、不半改）", () => {
    // 先正常建一个目标
    const ok = applyGoalEvent(null, toolCallStart(SET_GOAL_TOOL, { objective: "原目标", max_rounds: 10 }));
    expect(ok.goal, "前置：正常路径应建出目标").not.toBeNull();
    const before = ok.goal;
    // 已有目标时走 editGoal 分支；defaultMaxRounds 只在 createGoal 时读 ⇒ 这条不该抛，
    // 但要钉住"编辑后仍是同一个目标身份、轮次不被重置"（注释里写明的静默覆盖根因）
    const edited = applyGoalEvent(before, toolCallStart(SET_GOAL_TOOL, { objective: "改后的目标" }), { defaultMaxRounds: 0 });
    expect(edited.goal, "编辑失败或成功都不该把目标清空").not.toBeNull();
    expect(edited.goal!.round, "改目标不该把 round 归零（否则上限被静默重置）").toBe(before!.round);
  });

  it("④ 反证：正常 defaultMaxRounds ⇒ 目标建得出来（否则①②③会被『永远返回 null』的实现骗过）", () => {
    const out = applyGoalEvent(null, toolCallStart(SET_GOAL_TOOL, { objective: "正常目标" }), { defaultMaxRounds: 20 });
    expect(out.goal, "配置合法时必须能建出目标").not.toBeNull();
    expect(out.goal!.maxRounds).toBe(20);
  });

  it("⑤ 模型显式给了合法 max_rounds ⇒ 不读 defaultMaxRounds（坏配置也不影响）", () => {
    const out = applyGoalEvent(null, toolCallStart(SET_GOAL_TOOL, { objective: "带上限", max_rounds: 7 }), { defaultMaxRounds: 0 });
    expect(out.goal, "模型显式给了合法上限 ⇒ 不该被坏配置连带拖垮").not.toBeNull();
    expect(out.goal!.maxRounds).toBe(7);
  });
});
