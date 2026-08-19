/**
 * goal-extension —— pi 底座 extension：get_goal/create_goal/update_goal 三工具（DSH dsh-tool-goal 的 pi 移植）。
 *
 * 设计 docs/design/goal-ask-pi-port.md §6。语义对齐 DSH：工具名/入参/出参/动作枚举/blocked 阈值一字不差，
 * 只有 4 处 DSH 依赖替换：
 *   1. ctx.tools.register(defineTool) → pi.registerTool（窄类型 + JSON Schema）
 *   2. ctx.goals.*（事件溯源 GoalService）→ goal-fold.applyGoalOperation + goal-store.currentGoalFromBranch（单快照 + revision 连续）
 *   3. ctx.systemPrompt.section('tool:goal') → 本扩展描述里附带 prompt 策略（guidance 语义内联到 description/promptGuidelines）
 *   4. exec.deferContext(wrapup) → complete/blocked 把 wrapup 话术写进 tool result content 文本
 *
 * 决策 3A：不含 auto 续跑（goal-round-driver 整块不抄）——activation 位进程本地，创建置 armed，
 * 会话重启复位 disarmed，靠人类"继续"驱动模型 update_goal(resume) rearm。
 * 决策 6.5：requireDirectHuman 降级为"本会话见过人类输入（source rpc/interactive）"，无 per-turn 精确判定。
 *
 * 类型不 import 官方 pi 包（底座 node_modules 类型仓库 tsconfig 够不到）——手写窄结构，同 toolgate 纪律。
 * 本目录由 piExtensionEnsure 随插件启停同步到 ~/.pi/agent/extensions/goal/。
 */
import { applyGoalOperation, GoalError, type GoalAction, type GoalSnapshot } from "./goal-fold";
import { currentGoalFromBranch, type GoalSessionManager } from "./goal-store";

interface GoalToolResult {
  content: { type: "text"; text: string }[];
  details?: { goal: GoalSnapshot | null; activation?: string };
  isError?: boolean;
}

interface GoalToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: GoalExecuteContext,
  ): Promise<GoalToolResult>;
}

interface GoalInputEvent {
  source?: string;
}

interface GoalApi {
  on(event: "input", handler: (event: GoalInputEvent, ctx: unknown) => unknown): void;
  registerTool(tool: GoalToolDefinition): void;
}

interface GoalExecuteContext {
  mode?: string;
  sessionManager?: GoalSessionManager;
}

const GET_DESCRIPTION =
  "Read the current same-session goal, including its exact id/revision, objective, phase, completed "
  + "continuation rounds, round limit, blocker reason when present, and whether another continuation is armed. "
  + "Call this before updating a goal.";

const CREATE_DESCRIPTION =
  "Create one persisted same-session completion goal when the current direct human request "
  + "is a long-running objective that should continue across autonomous goal rounds. You may "
  + "infer that intent without requiring the user to say \"create a goal\". Do not use this for "
  + "trivial single-turn work. Execution rejects non-human and subagent authority.";

const UPDATE_DESCRIPTION =
  "Update the exact current goal revision. edit, pause, and resume require a direct "
  + "top-level human request. complete and blocked are also allowed during an automatic continuation. "
  + "blocked is rejected before the configured minimum round count; the model remains responsible for judging "
  + "that the same condition persisted and must explain it in blocked_reason.";

const BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3;

/** 模型可见的动作词（DSH 契约），"blocked" 在域层映射为 "block"。 */
type ModelAction = "edit" | "pause" | "resume" | "complete" | "blocked";

/** activation 是进程本地位（DSH 语义），不持久化；重启即 disarmed。 */
let activation: "armed" | "disarmed" = "disarmed";
let sawHumanInput = false;

/** DSH goalValue：稳定紧凑模型结果，activation 是观察不是重放状态。 */
function goalValue(goal: GoalSnapshot | null): { goal: null } | { goal: Record<string, unknown>; activation: string } {
  if (goal === null) return { goal: null };
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

function wrapup(objective: string, blockedReason?: string): string {
  return blockedReason === undefined
    ? `Goal marked complete. The objective "${objective}" has been achieved. Please give the user a final summary of what was accomplished.`
    : `Goal marked blocked. The objective "${objective}" could not be completed because: ${blockedReason}. Please report this to the user.`;
}

export default function goal(pi: GoalApi): void {
  pi.on("input", (event) => {
    if (event.source === "rpc" || event.source === "interactive") sawHumanInput = true;
  });

  const requireDirectHuman = (): void => {
    if (!sawHumanInput) {
      throw new GoalError("GOAL_AGENT_NOT_LIVE", "goal mutation requires a direct human request");
    }
  };

  const currentGoal = (ctx: GoalExecuteContext): GoalSnapshot | null => {
    const branch = ctx.sessionManager?.getBranch() ?? [];
    return currentGoalFromBranch(branch);
  };

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: GET_DESCRIPTION,
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _s, _u, ctx) {
      try {
        const goal = currentGoal(ctx);
        return { content: [{ type: "text", text: JSON.stringify(goalValue(goal)) }], details: { goal, activation } };
      } catch (err) {
        return { content: [{ type: "text", text: `get_goal failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true, details: { goal: null } };
      }
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: CREATE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The concrete completion objective inferred from the direct human request." },
        max_goal_rounds: { type: "number", description: "Optional positive safe-integer limit on automatic continuation rounds." },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    async execute(_id, rawParams, _s, _u, ctx) {
      try {
        requireDirectHuman();
        const params = rawParams as { objective?: string; max_goal_rounds?: number };
        const next = applyGoalOperation(currentGoal(ctx), "create", {
          objective: params.objective,
          maxGoalRounds: params.max_goal_rounds,
        }, Date.now());
        activation = "armed";
        return { content: [{ type: "text", text: JSON.stringify(goalValue(next)) }], details: { goal: next, activation } };
      } catch (err) {
        return { content: [{ type: "text", text: `create_goal failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true, details: { goal: currentGoal(ctx) } };
      }
    },
  });

  pi.registerTool({
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
    async execute(_id, rawParams, _s, _u, ctx) {
      try {
        requireDirectHuman();
        const params = rawParams as unknown as {
          goal_id?: string;
          revision?: number;
          action?: ModelAction;
          objective?: string;
          max_goal_rounds?: number;
          blocked_reason?: string;
        };
        const action = params.action;
        if (action === undefined || !["edit", "pause", "resume", "complete", "blocked"].includes(action)) {
          throw new GoalError("GOAL_INVALID_EDIT", "update_goal requires a valid action");
        }
        const op: GoalAction = action === "blocked" ? "block" : action;
        const goalId = params.goal_id;
        const revision = params.revision;
        if (typeof goalId !== "string" || goalId.length === 0 || !Number.isSafeInteger(revision as number) || (revision as number) < 1) {
          throw new GoalError("GOAL_STALE_REVISION", "goal_id must be non-empty and revision must be a positive safe integer");
        }
        const cur = currentGoal(ctx);
        if (cur === null) {
          throw new GoalError("GOAL_NOT_FOUND", "update_goal requires a current goal");
        }
        if (cur.id !== goalId || cur.revision !== revision) {
          throw new GoalError("GOAL_STALE_REVISION", "goal_id/revision does not match the current goal (compare-and-set)");
        }
        if (action === "blocked" && cur.roundsStarted < BLOCKED_AFTER_CONSECUTIVE_ROUNDS) {
          throw new GoalError("GOAL_TOOL_BLOCK_THRESHOLD",
            `blocked requires at least ${BLOCKED_AFTER_CONSECUTIVE_ROUNDS} consecutive goal rounds; current round is ${cur.roundsStarted}`);
        }
        const next = applyGoalOperation(cur, op, {
          ...(params.objective !== undefined ? { objective: params.objective } : {}),
          ...(params.max_goal_rounds !== undefined ? { maxGoalRounds: params.max_goal_rounds } : {}),
          ...(params.blocked_reason !== undefined ? { blockedReason: { code: "model-reported", message: params.blocked_reason } } : {}),
        }, Date.now());
        activation = action === "resume" ? "armed"
          : action === "pause" || action === "complete" || action === "blocked" ? "disarmed"
            : activation;
        const isTerminal = action === "complete" || action === "blocked";
        const contentText = isTerminal
          ? `${JSON.stringify(goalValue(next))}\n\n${wrapup(next.objective, action === "blocked" ? (params.blocked_reason ?? "") : undefined)}`
          : JSON.stringify(goalValue(next));
        return { content: [{ type: "text", text: contentText }], details: { goal: next, activation } };
      } catch (err) {
        return { content: [{ type: "text", text: `update_goal failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true, details: { goal: currentGoal(ctx) } };
      }
    },
  });
}
