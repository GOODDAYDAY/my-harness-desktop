import { opCall, WAIT_TIMEOUT_MS, type ToolDefinition } from "../runtime";

const TASK_SHAPE = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description, injected as the sub-agent's first prompt" },
        name: { type: "string", description: "Display name (default: first 20 chars of task)" },
        model: { type: "object", description: "{provider, modelId} override (default: inherit)" },
        toolConfig: { type: "object", description: "Per-task tool restriction, overrides the shared one" },
        allowSpawn: { type: "boolean", description: "Allow this sub-agent to spawn its own (default false)" },
      },
      required: ["task"],
      additionalProperties: false,
    },
  ],
};

export const spawnSubagentTool: ToolDefinition = {
  name: "spawn_subagent",
  label: "spawn_subagent",
  description:
    "Delegate work to sub-agent(s) — ONE call sets up a full scenario. Each sub-agent is an independent pi session with its own context, so its hundreds of messages stay out of yours. wait=true: block until the whole batch reaches a final state and return every result at once (fork-join). wait=false (default): return receipts immediately, each result arrives later as a 【子 agent 完成】 notification. channel: pull this batch into a shared room so sub-agents hear each other (war-room). toolConfig: shared tool restriction for restricted delegation (e.g. read-only analyst). Batch rejection is atomic (max_concurrent); a single failed spawn is reported per item as spawn_failed without blocking the rest.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: TASK_SHAPE,
        description: "Task list — a string is shorthand for {task}. One call = one full scenario (single / parallel fan-out / war-room).",
      },
      wait: { type: "boolean", description: "true = block until all reach final state and return all results; false (default) = async notify" },
      channel: { type: "string", description: "Room this batch auto-joins (created if missing) so they hear each other" },
      cwd: { type: "string", description: "Shared working directory (default: inherit yours)" },
      toolConfig: { type: "object", description: "Shared tool restriction, e.g. {mode:'custom', enabledToolIds:['read','bash']}" },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  execute: async (_id, params) =>
    opCall("spawn_subagent", params, params?.wait === true ? WAIT_TIMEOUT_MS : undefined),
};
