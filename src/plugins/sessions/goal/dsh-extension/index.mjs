/**
 * goal 的 dsh 内核插件 —— get_goal/create_goal/update_goal 三工具（文件侧车持久化）。
 *
 * 设计 docs/design/goal-ask-pi-port.md §6。不改 deepseek-harness：不依赖 dsh-goal 的
 * session 投影机制（那要 import dsh 内核包），改用文件侧车持久化——每会话一个 goal 快照，
 * 落 ~/.pi/agent/.my-harness-desktop-goals/<sessionId>.json，CAS 靠 {id, revision} 校验。
 * activation 位进程本地（重启即 disarmed，对齐 DSH 语义）；不含 auto 续跑（3A）。
 *
 * fold 状态机（phase 转移合法性 + revision 连续）由 pi 侧 goal-fold.ts 同款逻辑转写成 JS。
 * 零 import dsh 内核包，只用 node 内建模块。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "desktop-goal";

const GOALS_DIR = join(homedir(), ".pi", "agent", ".my-harness-desktop-goals");
const BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3;

const goalPath = (sessionId) => join(GOALS_DIR, `${sessionId}.json`);

/** activation 位进程本地（DSH 语义），不持久化；重启即 disarmed。 */
const activationBySession = new Map();

function readGoal(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(goalPath(sessionId), "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeGoal(sessionId, goal) {
  mkdirSync(GOALS_DIR, { recursive: true });
  writeFileSync(goalPath(sessionId), JSON.stringify(goal, null, 2), "utf8");
}

function isPositiveInt(n) {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
}

class GoalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}

/** 应用一次目标操作，产出 revision+1 的新快照（纯函数，对齐 pi goal-fold）。 */
function applyGoalOperation(cur, op, changes, now) {
  if (op === "create") {
    if (cur !== null && cur.phase !== "complete") {
      throw new GoalError("GOAL_ALREADY_EXISTS", "goal create requires no active current goal");
    }
    const objective = changes.objective;
    if (typeof objective !== "string" || objective.trim().length === 0) {
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

  if (cur === null) throw new GoalError("GOAL_NOT_FOUND", `goal ${op} requires a current goal`);
  const revision = cur.revision + 1;

  switch (op) {
    case "edit": {
      if (changes.blockedReason !== undefined) {
        throw new GoalError("GOAL_INVALID_EDIT", "blocked_reason is valid only with action blocked");
      }
      const objective = changes.objective !== undefined ? changes.objective : cur.objective;
      const maxGoalRounds = changes.maxGoalRounds !== undefined ? changes.maxGoalRounds : cur.maxGoalRounds;
      if (typeof objective !== "string" || objective.trim().length === 0) {
        throw new GoalError("GOAL_INVALID_OBJECTIVE", "goal edit requires a non-empty objective");
      }
      if (!isPositiveInt(maxGoalRounds)) {
        throw new GoalError("GOAL_INVALID_MAX_ROUNDS", "goal edit maxGoalRounds must be a positive safe integer");
      }
      return { ...cur, revision, objective: objective.trim(), maxGoalRounds, updatedAt: now };
    }
    case "pause":
      if (cur.phase !== "active") throw new GoalError("GOAL_INVALID_TRANSITION", "goal pause has an invalid phase transition");
      return { ...cur, revision, phase: "paused", updatedAt: now };
    case "resume": {
      const resumable = new Set(["active", "paused", "blocked"]);
      if (!resumable.has(cur.phase) || cur.roundsStarted >= cur.maxGoalRounds) {
        throw new GoalError("GOAL_INVALID_TRANSITION", "goal resume has an invalid phase transition or exhausted round budget");
      }
      return { ...cur, revision, phase: "active", updatedAt: now };
    }
    case "complete":
      if (cur.phase === "complete") throw new GoalError("GOAL_INVALID_TRANSITION", "goal complete has an invalid phase transition");
      return { ...cur, revision, phase: "complete", updatedAt: now };
    case "block": {
      if (cur.phase !== "active") throw new GoalError("GOAL_INVALID_TRANSITION", "goal block has an invalid phase transition");
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
    default:
      throw new GoalError("GOAL_INVALID_TRANSITION", `unknown goal operation ${String(op)}`);
  }
}

/** DSH goalValue：稳定紧凑模型结果，activation 是观察不是重放状态。 */
function goalValue(sessionId, goal) {
  if (goal === null) return { goal: null };
  const activation = activationBySession.get(sessionId) ?? "disarmed";
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined ? {} : {
        blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message },
      }),
    },
    activation,
  };
}

const sessionIdOf = (exec) => String(exec?.agent?.session?.id ?? "");
const textOf = (v) => JSON.stringify(v);

const GET_DESCRIPTION =
  "Read the current same-session goal, including its exact id/revision, objective, phase, "
  + "rounds, and whether another continuation is armed. Call this before updating a goal.";

const CREATE_DESCRIPTION =
  "Create one persisted same-session completion goal when the current direct human request "
  + "is a long-running objective. Do not use this for trivial single-turn work.";

const UPDATE_DESCRIPTION =
  "Update the exact current goal revision. edit, pause, resume require a direct human request; "
  + "complete and blocked report the terminal state. blocked requires a concrete blocked_reason.";

export function apply(ctx) {
  ctx.tools.register({
    name: "get_goal",
    label: "Get Goal",
    description: GET_DESCRIPTION,
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: textOf(value) }],
    },
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec);
      const goal = readGoal(sessionId);
      return goalValue(sessionId, goal);
    },
  });

  ctx.tools.register({
    name: "create_goal",
    label: "Create Goal",
    description: CREATE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The concrete completion objective." },
        max_goal_rounds: { type: "number", description: "Optional positive safe-integer limit." },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: textOf(value) }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      try {
        const cur = readGoal(sessionId);
        const next = applyGoalOperation(cur, "create", {
          objective: args.objective,
          maxGoalRounds: args.max_goal_rounds,
        }, Date.now());
        writeGoal(sessionId, next);
        activationBySession.set(sessionId, "armed");
        return goalValue(sessionId, next);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  ctx.tools.register({
    name: "update_goal",
    label: "Update Goal",
    description: UPDATE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "Exact id returned by get_goal." },
        revision: { type: "number", description: "Exact positive revision returned by get_goal." },
        action: { type: "string", enum: ["edit", "pause", "resume", "complete", "blocked"], description: "edit | pause | resume | complete | blocked" },
        objective: { type: "string", description: "Replacement objective; valid only with action edit." },
        max_goal_rounds: { type: "number", description: "Replacement cap; valid only with action edit." },
        blocked_reason: { type: "string", description: "Concrete blocking condition; required only with action blocked." },
      },
      required: ["goal_id", "revision", "action"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: textOf(value) }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      try {
        const action = args.action;
        if (!["edit", "pause", "resume", "complete", "blocked"].includes(action)) {
          throw new GoalError("GOAL_INVALID_EDIT", "update_goal requires a valid action");
        }
        const goalId = args.goal_id;
        const revision = args.revision;
        if (typeof goalId !== "string" || goalId.length === 0 || !Number.isSafeInteger(revision) || revision < 1) {
          throw new GoalError("GOAL_STALE_REVISION", "goal_id must be non-empty and revision must be a positive safe integer");
        }
        const cur = readGoal(sessionId);
        if (cur === null) throw new GoalError("GOAL_NOT_FOUND", "update_goal requires a current goal");
        if (cur.id !== goalId || cur.revision !== revision) {
          throw new GoalError("GOAL_STALE_REVISION", "goal_id/revision does not match the current goal (compare-and-set)");
        }
        const op = action === "blocked" ? "block" : action;
        if (action === "blocked" && cur.roundsStarted < BLOCKED_AFTER_CONSECUTIVE_ROUNDS) {
          throw new GoalError("GOAL_TOOL_BLOCK_THRESHOLD",
            `blocked requires at least ${BLOCKED_AFTER_CONSECUTIVE_ROUNDS} consecutive goal rounds`);
        }
        const next = applyGoalOperation(cur, op, {
          ...(args.objective !== undefined ? { objective: args.objective } : {}),
          ...(args.max_goal_rounds !== undefined ? { maxGoalRounds: args.max_goal_rounds } : {}),
          ...(args.blocked_reason !== undefined ? { blockedReason: { code: "model-reported", message: args.blocked_reason } } : {}),
        }, Date.now());
        writeGoal(sessionId, next);
        activationBySession.set(sessionId, action === "resume" ? "armed"
          : action === "pause" || action === "complete" || action === "blocked" ? "disarmed"
            : activationBySession.get(sessionId) ?? "disarmed");
        return goalValue(sessionId, next);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
