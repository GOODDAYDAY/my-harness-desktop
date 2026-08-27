/**
 * goal-extension —— pi 内核扩展:set_goal / achieve_goal 两个薄工具(DSH goal-round-driver 语义的 pi 面)。
 *
 * 设计 docs/design/kernel-agnostic-goal.md。与上一版(goal-ask-pi-port 的 get_goal/create_goal/update_goal
 * 三工具 + 扩展内持久化)的根本区别:**工具退化为薄标记,状态机(圆心纯函数)与续跑引擎(壳插件
 * goal-controller)都在插件侧,不碰 core/application、契约、IPC。
 *
 * 本扩展只做两件事:
 *   1. 注册 set_goal / achieve_goal,让模型能调用(工具是内核注册的,壳注入不了——这是唯一留在内核侧的部分);
 *   2. 返回一个确认文本。真正的目标状态、续跑,由壳插件经中性事件(toolCallStart)捕获、在插件内驱动。
 *
 * 不 import 官方 pi 包(内核 node_modules 类型仓库 tsconfig 够不到)——手写窄结构,同 toolgate 纪律。
 * 本目录由 piExtensionEnsure 随插件启停同步到 ~/.pi/agent/extensions/goal/。
 */

interface GoalToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface GoalToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<GoalToolResult>;
}

interface GoalApi {
  registerTool(tool: GoalToolDefinition): void;
}

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

/** 确认文本(模型读到即可;真正的状态归壳层,本工具不落盘、不维护)。 */
function ack(value: Record<string, unknown>): GoalToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export default function goal(pi: GoalApi): void {
  pi.registerTool({
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
    async execute(_id, params) {
      const objective = typeof params.objective === "string" && params.objective.trim().length > 0
        ? params.objective.trim()
        : "";
      if (objective === "") {
        return { content: [{ type: "text", text: "set_goal failed: objective must be a non-empty string" }], isError: true };
      }
      return ack({ goal: { objective, ...(typeof params.max_rounds === "number" ? { max_rounds: params.max_rounds } : {}) } });
    },
  });

  pi.registerTool({
    name: "achieve_goal",
    label: "Achieve Goal",
    description: ACHIEVE_DESCRIPTION,
    parameters: { type: "object", properties: {} },
    async execute() {
      return ack({ goal: { achieved: true } });
    },
  });
}
