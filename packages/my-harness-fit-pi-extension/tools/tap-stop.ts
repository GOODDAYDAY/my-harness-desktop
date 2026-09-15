import { busOpCall, type ToolDefinition } from "../runtime";

export const tapStopTool: ToolDefinition = {
  name: "tap_stop",
  label: "tap_stop",
  description:
    "Stop bus subscriptions. With tapId: stop that one tap. Without tapId: stop ALL your subscriptions (taps + any session_create watch registrations) — this is the only way to unwatch. Returns {stopped, removed}; stopped honestly reflects whether anything was actually removed.",
  parameters: {
    type: "object",
    properties: { tapId: { type: "string", description: "Tap id to stop; omit to stop all your subscriptions (incl. watch)" } },
    required: [],
    additionalProperties: false,
  },
  execute: async (_id, params) => busOpCall("tap_stop", params),
};
