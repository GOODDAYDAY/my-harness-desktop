import { ADDR_PROP, opCall, type ToolDefinition } from "../runtime";

export const sessionAbortTool: ToolDefinition = {
  name: "session_abort",
  label: "session_abort",
  description:
    "Stop a session process (self or others). Watchers get session_done with status=aborted; rooms get peer_left.",
  parameters: {
    type: "object",
    properties: { session: ADDR_PROP },
    required: ["session"],
    additionalProperties: false,
  },
  execute: async (_id, params) => opCall("session_abort", params),
};
