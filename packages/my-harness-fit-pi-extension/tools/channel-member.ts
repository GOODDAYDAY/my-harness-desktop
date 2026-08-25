import { ADDR_PROP, busOpCall, type ToolDefinition } from "../runtime";

export const channelMemberTool: ToolDefinition = {
  name: "channel_member",
  label: "channel_member",
  description:
    "Join or leave a channel (action: join | leave). member defaults to yourself — pass another session address to broker it in/out. Channels are created on first join and dissolve when empty. Join = send & receive; leave = mute.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string" },
      action: { type: "string", description: "join | leave" },
      member: { ...ADDR_PROP, description: "Address to join/remove (default: self)" },
    },
    required: ["channel", "action"],
    additionalProperties: false,
  },
  execute: async (_id, params) => busOpCall("channel_member", params),
};
