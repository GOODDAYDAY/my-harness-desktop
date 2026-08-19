/**
 * goal-store —— 从会话分支重放折叠出"当前 goal"（DSH foldGoal 的 pi 退化形态）。
 *
 * 设计 docs/design/goal-ask-pi-port.md §6.3。pi 无"追加类型化会话事件"的通用 API，
 * 采用 session-orchestrator 的 task/scratchpad 同款手法：goal 快照随 create_goal/update_goal
 * 的工具结果 details.goal 落盘，currentGoalFromBranch 从 getBranch() 重放重建——
 * 分叉安全、跨会话重启可恢复（activation 位进程本地，重启即 disarmed，对齐 DSH）。
 */

import type { GoalSnapshot } from "./goal-fold";

interface BranchMessage {
  role?: string;
  toolName?: string;
  details?: unknown;
}

interface BranchEntry {
  type?: string;
  message?: BranchMessage;
}

export interface GoalSessionManager {
  getSessionFile(): string | undefined;
  getBranch(): BranchEntry[];
}

/** 唯一产生 goal 快照的两个变更工具（get_goal 只读，不落 details.goal，不污染重放）。 */
const MUTATORS: ReadonlySet<string> = new Set(["create_goal", "update_goal"]);

/** 从分支事件流重放，返回当前 goal（最后一条变更工具结果的 details.goal）。 */
export function currentGoalFromBranch(branch: BranchEntry[]): GoalSnapshot | null {
  let goal: GoalSnapshot | null = null;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult") continue;
    if (!msg.toolName || !MUTATORS.has(msg.toolName)) continue;
    const d = msg.details as { goal?: GoalSnapshot } | undefined;
    if (d && d.goal) goal = d.goal;
  }
  return goal;
}
