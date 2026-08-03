import { opCall, type ToolDefinition } from "../runtime";

export const sessionCreateTool: ToolDefinition = {
  name: "session_create",
  label: "session_create",
  description:
    "Spawn a NEW pi session (independent process, own context) and optionally give it a task in ONE call. task: injected as first prompt immediately. watch=true: you get session_done with the COMPLETE final output when it finishes. channels: the new session auto-joins these rooms (created if missing). Use for delegating work to sub-agents — task + watch + channels covers a full dispatch in one round.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "First prompt to inject (task description)" },
      cwd: { type: "string", description: "Working directory (default: caller's cwd)" },
      name: { type: "string", description: "Session display name" },
      model: { type: "object", description: "{provider, modelId} override (default: inherit)" },
      toolConfig: { type: "object", description: "{mode, enabledToolIds?} tool restriction" },
      watch: { type: "boolean", description: "Notify me with full output when done" },
      channels: { type: "array", items: { type: "string" }, description: "Rooms the new session auto-joins" },
    },
    required: [],
    additionalProperties: false,
  },
  execute: async (_id, params) => opCall("session_create", params),
};
