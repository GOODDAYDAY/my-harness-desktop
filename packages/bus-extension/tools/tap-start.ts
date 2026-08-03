import { ADDR_PROP, opCall, type ToolDefinition } from "../runtime";

export const tapStartTool: ToolDefinition = {
  name: "tap_start",
  label: "tap_start",
  description:
    "Observe a session's events or a channel's message flow (read-only). filter: done (default, completion signal only) | lifecycle (+ boundary events) | stream (all events, plugin targets only). deliverTo defaults to yourself; pass a third-party address to broker observation. Completion always delivers session_done with the FULL final output. Returns tapId.",
  parameters: {
    type: "object",
    properties: {
      session: { ...ADDR_PROP, description: "Session address to observe" },
      channel: { type: "string", description: "Channel name to observe (filter not applicable)" },
      filter: { type: "string", description: "done | lifecycle | stream" },
      deliverTo: { ...ADDR_PROP, description: "Where events go (default: self)" },
    },
    required: [],
    additionalProperties: false,
  },
  execute: async (_id, params) => opCall("tap_start", params),
};
