import { opCall, type ToolDefinition } from "../runtime";

export const sendToSubagentTool: ToolDefinition = {
  name: "send_to_subagent",
  label: "send_to_subagent",
  description:
    "Send a one-way follow-up instruction to a RUNNING sub-agent you own (course correction / extra constraint). Queued into its input without interrupting its current turn. You can only message your own sub-agents; finished ones reject with subagent_finished.",
  parameters: {
    type: "object",
    properties: {
      subagent: { type: "string", description: "Sub-agent bus address (session:<key>)" },
      message: { type: "string", description: "The follow-up instruction text" },
    },
    required: ["subagent", "message"],
    additionalProperties: false,
  },
  execute: async (_id, params) => opCall("send_to_subagent", params),
};
