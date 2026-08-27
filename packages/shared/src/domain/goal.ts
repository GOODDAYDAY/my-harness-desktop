// 圆心:goal 能力契约 —— 同会话持久目标的状态机(纯函数,零依赖)。
//
// 定位(设计 docs/design/kernel-agnostic-goal.md):goal 是**内核无关的壳层机制**。
// 状态机只回答「目标现在是什么状态、还该不该续跑」,不碰 IO、不碰内核、不碰进程。
// 续跑编排在 application 层(goal-driver),模型工具在内核侧(pi 扩展 set_goal/achieve_goal,
// 薄标记),两边经中性事件(toolCallStart + agentSettled)桥接——壳只认中性域,内核身份不进场。

export type GoalPhase = "active" | "paused" | "achieved";

/** 一个同会话目标的可观测状态(纯数据,可序列化)。 */
export interface GoalState {
  /** 人类请求的完成目标。 */
  objective: string;
  /** 生命周期阶段:active=续跑中,paused=用户暂停(停止续跑、可恢复),achieved=已达成。 */
  phase: GoalPhase;
  /** 已发起的续跑轮数(set_goal 后每续跑一轮 +1)。 */
  round: number;
  /** 续跑轮数上限(防失控安全阀)。 */
  maxRounds: number;
}

/** set_goal 的入参(去掉了模型工具层的命名差异,这里是中性请求)。 */
export interface SetGoalRequest {
  objective: string;
  maxRounds?: number;
}

/** 未显式指定时的续跑轮数上限(对齐 DSH 的 defaultMaxGoalRounds)。 */
export const DEFAULT_MAX_GOAL_ROUNDS = 256;

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
}

function normalizeObjective(v: unknown): string | null {
  if (typeof v !== "string" || v.trim().length === 0) return null;
  return v.trim();
}

function resolveMaxRounds(v: unknown): number | null {
  if (v === undefined) return DEFAULT_MAX_GOAL_ROUNDS;
  return isPositiveInt(v) ? v : null;
}

/** 校验并创建目标:objective 非空、maxRounds 正整数(缺省用默认)。非法入参抛错。 */
export function createGoal(request: SetGoalRequest): GoalState {
  const objective = normalizeObjective(request.objective);
  if (objective === null) throw new Error("goal objective must be a non-empty string");
  const maxRounds = resolveMaxRounds(request.maxRounds);
  if (maxRounds === null) throw new Error("goal maxRounds must be a positive safe integer");
  return { objective, phase: "active", round: 0, maxRounds };
}

/** 标记达成:任意非 achieved 阶段 → achieved(幂等,已达成不抛错、不重复推进)。 */
export function achieveGoal(state: GoalState): GoalState {
  if (state.phase === "achieved") return state;
  return { ...state, phase: "achieved" };
}

/** 用户暂停:active → paused(停止续跑)。非 active 阶段幂等返回原状态(不抛)。 */
export function pauseGoal(state: GoalState): GoalState {
  if (state.phase !== "active") return state;
  return { ...state, phase: "paused" };
}

/** 用户恢复:paused → active(重新续跑)。非 paused 阶段幂等返回原状态(不抛)。 */
export function resumeGoal(state: GoalState): GoalState {
  if (state.phase !== "paused") return state;
  return { ...state, phase: "active" };
}

/** 用户改目标:只换 objective(下次续跑生效),阶段/轮数/上限不变。空 objective 拒绝。 */
export function editGoal(state: GoalState, objective: string): GoalState {
  const next = normalizeObjective(objective);
  if (next === null) throw new Error("goal objective must be a non-empty string");
  return { ...state, objective: next };
}

/** 是否还应续跑:active 且未达轮数上限(paused/achieved 都不续)。 */
export function shouldContinue(state: GoalState): boolean {
  return state.phase === "active" && state.round < state.maxRounds;
}

/** 从 set_goal 的工具入参宽松解析 objective/max_rounds;解析失败返回 null(驱动据此静默忽略)。 */
export function parseSetGoalArgs(args: unknown): SetGoalRequest | null {
  if (typeof args !== "object" || args === null) return null;
  const o = args as Record<string, unknown>;
  const objective = normalizeObjective(o["objective"]);
  if (objective === null) return null;
  const maxRounds = o["max_rounds"];
  if (maxRounds !== undefined && !isPositiveInt(maxRounds)) return null;
  return { objective, ...(maxRounds !== undefined ? { maxRounds } : {}) };
}

/**
 * 壳插件的 goal 能力面(SessionsApi.goal):读当前目标 + 用户控制(停止/恢复/修改/关闭)+ 变更订阅。
 * 状态机在 main 进程的 GoalDriver,渲染层经此面读写;内核身份不进场(§7.5 不变量)。
 */
export interface GoalApi {
  /** 当前目标;无目标返回 null。 */
  get(): Promise<GoalState | null>;
  /** 用户停止:desktop 不再发送续跑,随时可 resume。 */
  pause(): Promise<void>;
  /** 用户恢复:重新续跑。 */
  resume(): Promise<void>;
  /** 用户改目标:下次续跑生效。 */
  edit(objective: string): Promise<void>;
  /** 用户关闭:清空当前目标。 */
  clear(): Promise<void>;
  /** 订阅目标状态变更(null = 已清空)。返回取消函数。 */
  onChange(cb: (state: GoalState | null) => void): () => void;
}
