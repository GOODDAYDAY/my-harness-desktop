import { subagentOpCall, WAIT_TIMEOUT_MS, type ToolDefinition } from "../runtime";

export const waitSubagentTool: ToolDefinition = {
  name: "wait_subagent",
  label: "wait_subagent",
  description:
    "Block until one sub-agent reaches a final state and return its full result — the 'join later' option when you spawned async and now need to consolidate. Prefer declaring wait=true at spawn time when you already know the dependency. Waiting on a finished sub-agent returns immediately (idempotent); a wait timeout does NOT affect the sub-agent, its result still arrives via the done notification.",
  parameters: {
    type: "object",
    properties: {
      subagent: { type: "string", description: "Sub-agent bus address (session:<key>), as returned by spawn_subagent" },
      timeout_ms: { type: "number", description: "Max wait; default unbounded (follows the sub-agent's own timeout guard)" },
    },
    required: ["subagent"],
    additionalProperties: false,
  },
  execute: async (_id, params) => subagentOpCall("wait_subagent", params, WAIT_TIMEOUT_MS),
};
