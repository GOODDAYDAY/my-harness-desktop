import { subagentOpCall, type ToolDefinition } from "../runtime";

export const abortSubagentTool: ToolDefinition = {
  name: "abort_subagent",
  label: "abort_subagent",
  description:
    "Stop a running sub-agent you own (stdin→SIGTERM→SIGKILL stop chain). You can only abort your own sub-agents. Aborting an already-finished one is idempotent — returns its current final state without error.",
  parameters: {
    type: "object",
    properties: {
      subagent: { type: "string", description: "Sub-agent bus address (session:<key>)" },
      reason: { type: "string", description: "Recorded into the sub-agent's session header and the parent entry" },
    },
    required: ["subagent"],
    additionalProperties: false,
  },
  execute: async (_id, params) => subagentOpCall("abort_subagent", params),
};
