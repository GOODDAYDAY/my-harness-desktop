import { opCall, type ToolDefinition } from "../runtime";

export const listSubagentsTool: ToolDefinition = {
  name: "list_subagents",
  label: "list_subagents",
  description:
    "List YOUR sub-agents and their states in one call — the only reconnaissance entry before/after orchestration. Finished ones carry an output preview; full output is readable via their session file path.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", description: '"active" | "done" | "all" (default "all", includes history)' },
    },
    required: [],
    additionalProperties: false,
  },
  execute: async (_id, params) => opCall("list_subagents", params),
};
