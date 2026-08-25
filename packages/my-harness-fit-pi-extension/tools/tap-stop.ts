import { busOpCall, type ToolDefinition } from "../runtime";

export const tapStopTool: ToolDefinition = {
  name: "tap_stop",
  label: "tap_stop",
  description: "Stop an active tap by tapId.",
  parameters: {
    type: "object",
    properties: { tapId: { type: "string" } },
    required: ["tapId"],
    additionalProperties: false,
  },
  execute: async (_id, params) => busOpCall("tap_stop", params),
};
