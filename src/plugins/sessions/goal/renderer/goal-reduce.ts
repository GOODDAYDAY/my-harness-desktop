// goal 事件归约 —— 纯函数(零 React),可裸单测。
// 把「一条中性会话事件」归约成「目标状态变化 + 可选续跑提示」:续跑引擎(goal-controller)
// 只做订阅 + 发消息,归约逻辑在这里,内核无关、框架无关。

import type { SessionEvent } from "@my-harness-desktop/shared";
import type { GoalState } from "../core/goal-state";
import { achieveGoal, createGoal, parseSetGoalArgs, shouldContinue } from "../core/goal-state";

export const SET_GOAL_TOOL = "set_goal";
export const ACHIEVE_GOAL_TOOL = "achieve_goal";

/** 续跑提示文案(与 DSH goal-round-driver 的 <goal_round> 同语义;内容是插件的事,不进圆心)。 */
export function renderContinuationPrompt(objective: string, round: number, maxRounds: number): string {
  return [
    "<goal_round>",
    `Objective: ${JSON.stringify(objective)}`,
    `Round: ${round}/${maxRounds}`,
    "",
    "Continue working toward the objective in this same session. Treat the current workspace, "
    + "tool results, and durable session state as authoritative; inspect them instead of assuming "
    + "earlier narration is still current. Make concrete progress and verify the result. When the "
    + "whole objective is achieved, call the achieve_goal tool. If it is not yet achieved, keep "
    + "working and the goal will be continued on the next round.",
    "</goal_round>",
  ].join("\n");
}

function toolNameOf(event: SessionEvent): string | undefined {
  const e = event as { toolName?: unknown; name?: unknown };
  return typeof e.toolName === "string" ? e.toolName : typeof e.name === "string" ? e.name : undefined;
}

function argsOf(event: SessionEvent): unknown {
  const e = event as { args?: unknown; input?: unknown; arguments?: unknown };
  return e.args ?? e.input ?? e.arguments;
}

/** 一次归约的结果:新的目标状态 + 本轮是否要发续跑提示(prompt 非空 = 要发)。 */
export interface GoalReduce {
  goal: GoalState | null;
  prompt?: string;
}

/** 归约一条中性事件到目标状态。续跑提示由调用方(续跑引擎)执行,本函数零副作用。 */
export function applyGoalEvent(state: GoalState | null, event: SessionEvent): GoalReduce {
  if (event.type === "toolCallStart") {
    const name = toolNameOf(event);
    if (name === SET_GOAL_TOOL) {
      const request = parseSetGoalArgs(argsOf(event));
      if (request === null) return { goal: state }; // 畸形入参:静默忽略
      try { return { goal: createGoal(request) }; } catch { return { goal: state }; }
    }
    if (name === ACHIEVE_GOAL_TOOL) {
      return { goal: state ? achieveGoal(state) : state };
    }
    return { goal: state };
  }
  if (event.type === "agentSettled") {
    if (!state || !shouldContinue(state)) return { goal: state };
    const round = state.round + 1;
    return {
      goal: { ...state, round },
      prompt: renderContinuationPrompt(state.objective, round, state.maxRounds),
    };
  }
  return { goal: state };
}
