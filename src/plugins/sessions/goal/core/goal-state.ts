// 圆心:goal 状态机(纯函数,零依赖)。
//
// 定位:goal 是**纯插件能力**,不是壳机制。圆心只留「目标现在是什么状态、还该不该续跑」的
// 纯函数状态机,供壳插件(续跑引擎)与内核插件(两个薄工具)共用同一定义(契约单源 §1.3)。
// 续跑编排/UI 都在壳插件(plugins/sessions/goal),模型工具在内核插件(pi 扩展 + dsh cordis),
// 壳的 core/application、契约、IPC 一概不碰——薄壳架构(§1.2 机制与内容分离)。

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

/** 从 set_goal 的工具入参宽松解析 objective/max_rounds;解析失败返回 null(续跑引擎据此静默忽略)。 */
export function parseSetGoalArgs(args: unknown): SetGoalRequest | null {
  if (typeof args !== "object" || args === null) return null;
  const o = args as Record<string, unknown>;
  const objective = normalizeObjective(o["objective"]);
  if (objective === null) return null;
  const maxRounds = o["max_rounds"];
  if (maxRounds !== undefined && !isPositiveInt(maxRounds)) return null;
  return { objective, ...(maxRounds !== undefined ? { maxRounds } : {}) };
}

/** 从头行 custom.goal 读回并校验一个已持久化的目标;畸形/缺失返回 null(静默忽略,不炸续跑引擎)。
 *  防御式解析:目标状态是插件自己落盘的数据,但可能被手改/旧版本污染,读回不信任。 */
export function parseGoal(v: unknown): GoalState | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const objective = normalizeObjective(o["objective"]);
  if (objective === null) return null;
  const phase = o["phase"];
  if (phase !== "active" && phase !== "paused" && phase !== "achieved") return null;
  const round = o["round"];
  if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 0) return null;
  const maxRounds = o["maxRounds"];
  if (!isPositiveInt(maxRounds)) return null;
  return { objective, phase, round, maxRounds };
}
