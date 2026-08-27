/**
 * goal 的 dsh 内核插件 —— set_goal / achieve_goal 两个薄工具。
 *
 * 设计 docs/design/kernel-agnostic-goal.md §6:工具退化为薄标记,只返回确认文本;
 * 真正的目标状态机与续跑全部在壳层(application/goal-driver),经中性 toolCallStart 事件
 * (dsh-event-translator 把 tool/call 映射为 toolCallStart)捕获——本插件不落盘、不维护状态。
 *
 * 零 import dsh 内核包(与 pi 扩展同纪律):只依赖 cordis 的 ctx.tools 注入面。
 * 本目录由 dshExtensionEnsure 随插件启停同步到 ~/.dsh/.my-harness-desktop-plugins/goal/。
 */
export const name = "desktop-goal";

// cordis 服务依赖声明:apply 里访问 ctx.tools 必须先在此注入,否则插件树加载期抛
// "cannot get property tools without inject" → 整个 dsh 内核崩溃(对齐旧 goal 插件的 inject 纪律)。
export const inject = ["tools"];

const SET_DESCRIPTION =
  "Set the current long-running completion objective for this session. After this is set, the "
  + "desktop will automatically keep sending continuation prompts after each turn until the "
  + "objective is achieved (or the round limit is reached), so the work continues autonomously "
  + "across turns without further human prompts. Use this only for a real long-running objective "
  + "that should continue across many turns; do not use it for trivial single-turn work.";

const ACHIEVE_DESCRIPTION =
  "Mark the current goal as achieved. Call this only when the whole objective has actually been "
  + "completed and verified against the current workspace and tool results. After this, the desktop "
  + "stops sending continuation prompts and the goal is finished.";

const outputOf = () => ({
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
});

export function apply(ctx) {
  ctx.tools.register({
    name: "set_goal",
    label: "Set Goal",
    description: SET_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The concrete completion objective for this session." },
        max_rounds: { type: "number", description: "Optional positive integer limit on automatic continuation rounds." },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    output: outputOf(),
    async execute(args) {
      const objective = typeof args.objective === "string" && args.objective.trim().length > 0
        ? args.objective.trim()
        : "";
      if (objective === "") {
        return { error: "set_goal failed: objective must be a non-empty string" };
      }
      return { goal: { objective, ...(typeof args.max_rounds === "number" ? { max_rounds: args.max_rounds } : {}) } };
    },
  });

  ctx.tools.register({
    name: "achieve_goal",
    label: "Achieve Goal",
    description: ACHIEVE_DESCRIPTION,
    parameters: { type: "object", properties: {} },
    output: outputOf(),
    async execute() {
      return { goal: { achieved: true } };
    },
  });
}
