// 运行状态类型与推进纯函数 —— 面板运行区的展示模型 + runner 的进度上报形状。
// 纯数据、纯函数:组件渲染和 runner 上报共用同一份,杜绝两处各造状态形状漂移(契约单源)。

import type { TeamConfig } from "./config";

export type RunItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface TeamRunState {
  id: string;
  name: string;
  status: RunItemStatus;
}

export type SquadPhase = "teams" | "judge" | "done" | "cancelled";

export interface SquadRunState {
  teams: TeamRunState[];
  /** null = 本次运行无裁判(单发模式)。 */
  judgeStatus: RunItemStatus | null;
  phase: SquadPhase;
}

export function initRunState(teams: TeamConfig[], withJudge: boolean): SquadRunState {
  return {
    teams: teams.map((t) => ({ id: t.id, name: t.name, status: "pending" })),
    judgeStatus: withJudge ? "pending" : null,
    phase: "teams",
  };
}

export function markTeam(state: SquadRunState, id: string, status: RunItemStatus): SquadRunState {
  return { ...state, teams: state.teams.map((t) => (t.id === id ? { ...t, status } : t)) };
}

export function markJudge(state: SquadRunState, status: RunItemStatus): SquadRunState {
  return { ...state, judgeStatus: status };
}

export function markPhase(state: SquadRunState, phase: SquadPhase): SquadRunState {
  return { ...state, phase };
}
