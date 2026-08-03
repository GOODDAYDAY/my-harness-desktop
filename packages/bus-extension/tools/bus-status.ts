import { opCall, type ToolDefinition } from "../runtime";

export const busStatusTool: ToolDefinition = {
  name: "bus_status",
  label: "bus_status",
  description:
    "ONE call for the full bus picture: who I am (address/channels/taps), all running sessions (address/name/cwd/busy), all channels with members. Always call this first when planning orchestration.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  execute: async () => opCall("bus_status", {}),
};
