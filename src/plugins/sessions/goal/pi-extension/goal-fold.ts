/**
 * goal-fold —— DSH packages/goal/goal/src/fold.ts 的 pi 移植（纯函数，零副作用）。
 *
 * 设计 docs/design/goal-ask-pi-port.md §6.3/§6.4。DSH 是事件溯源（goal/change 事件流 + 严格重放折叠），
 * pi 版退化为"单快照 + revision 连续校验"：applyGoalOperation 校验 phase 转移合法性、
 * revision 连续、同一目标定义不变、blocked_reason 形状，然后产出 revision+1 的新快照。
 * 本文件可裸单测（不 import 任何运行时），是抄写价值最高的一段。
 */

export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type GoalOperation = "create" | "edit" | "pause" | "resume" | "complete" | "block";
export type GoalAction = Exclude<GoalOperation, "create">;

export interface GoalBlockReason {
  code: string;
  message: string;
}

export interface GoalSnapshot {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  maxGoalRounds: number;
  roundsStarted: number;
  blockedReason?: GoalBlockReason;
  createdAt: number;
  updatedAt: number;
}

export interface GoalChangeSet {
  objective?: string;
  maxGoalRounds?: number;
  blockedReason?: GoalBlockReason;
}

export class GoalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}

const PHASES: ReadonlySet<GoalPhase> = new Set(["active", "paused", "blocked", "complete"]);

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
}

/** 校验并应用一次目标操作，产出 revision+1 的新快照（纯函数）。 */
export function applyGoalOperation(
  cur: GoalSnapshot | null,
  op: GoalOperation,
  changes: GoalChangeSet,
  now: number,
): GoalSnapshot {
  if (op === "create") {
    if (cur !== null && cur.phase !== "complete") {
      throw new GoalError("GOAL_ALREADY_EXISTS", "goal create requires no active current goal");
    }
    const objective = changes.objective;
    if (objective === undefined || objective.trim().length === 0) {
      throw new GoalError("GOAL_INVALID_OBJECTIVE", "goal create requires a non-empty objective");
    }
    const maxGoalRounds = changes.maxGoalRounds ?? 8;
    if (!isPositiveInt(maxGoalRounds)) {
      throw new GoalError("GOAL_INVALID_MAX_ROUNDS", "goal create maxGoalRounds must be a positive safe integer");
    }
    return {
      id: `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      revision: 1,
      objective: objective.trim(),
      phase: "active",
      maxGoalRounds,
      roundsStarted: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (cur === null) {
    throw new GoalError("GOAL_NOT_FOUND", `goal ${op} requires a current goal`);
  }
  const revision = cur.revision + 1;

  switch (op) {
    case "edit": {
      if (changes.blockedReason !== undefined) {
        throw new GoalError("GOAL_INVALID_EDIT", "blocked_reason is valid only with action blocked");
      }
      const objective = changes.objective !== undefined ? changes.objective : cur.objective;
      const maxGoalRounds = changes.maxGoalRounds !== undefined ? changes.maxGoalRounds : cur.maxGoalRounds;
      if (objective.trim().length === 0) {
        throw new GoalError("GOAL_INVALID_OBJECTIVE", "goal edit requires a non-empty objective");
      }
      if (!isPositiveInt(maxGoalRounds)) {
        throw new GoalError("GOAL_INVALID_MAX_ROUNDS", "goal edit maxGoalRounds must be a positive safe integer");
      }
      // edit 只改 objective/maxGoalRounds，phase 与 blockedReason 原样保留
      return { ...cur, revision, objective: objective.trim(), maxGoalRounds, updatedAt: now };
    }
    case "pause": {
      if (cur.phase !== "active") {
        throw new GoalError("GOAL_INVALID_TRANSITION", "goal pause has an invalid phase transition");
      }
      return { ...cur, revision, phase: "paused", updatedAt: now };
    }
    case "resume": {
      const resumable: ReadonlySet<GoalPhase> = new Set(["active", "paused", "blocked"]);
      if (!resumable.has(cur.phase) || cur.roundsStarted >= cur.maxGoalRounds) {
        throw new GoalError("GOAL_INVALID_TRANSITION", "goal resume has an invalid phase transition or exhausted round budget");
      }
      return { ...cur, revision, phase: "active", updatedAt: now };
    }
    case "complete": {
      if (cur.phase === "complete") {
        throw new GoalError("GOAL_INVALID_TRANSITION", "goal complete has an invalid phase transition");
      }
      return { ...cur, revision, phase: "complete", updatedAt: now };
    }
    case "block": {
      if (cur.phase !== "active") {
        throw new GoalError("GOAL_INVALID_TRANSITION", "goal block has an invalid phase transition");
      }
      if (!changes.blockedReason || changes.blockedReason.message.trim().length === 0) {
        throw new GoalError("GOAL_INVALID_BLOCK_REASON", "goal block requires a concrete blocked_reason");
      }
      return {
        ...cur,
        revision,
        phase: "blocked",
        blockedReason: { code: changes.blockedReason.code, message: changes.blockedReason.message.trim() },
        updatedAt: now,
      };
    }
    default: {
      const _exhaustive: never = op;
      throw new GoalError("GOAL_INVALID_TRANSITION", `unknown goal operation ${String(_exhaustive)}`);
    }
  }
}

export function isGoalPhase(v: unknown): v is GoalPhase {
  return typeof v === "string" && PHASES.has(v as GoalPhase);
}
