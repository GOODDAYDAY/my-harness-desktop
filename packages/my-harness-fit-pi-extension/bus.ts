/**
 * bus 能力 —— Session Bus 的 agent 侧能力面(入口接线层)。
 * (原 packages/bus-extension/index.ts;input 钩子已上提 index.ts 统一路由)
 *
 * 设计:docs/design/session-bus.md。本模块只做两件事:
 * 1. session_start 时 ping 探测 desktop,有 desktop 才注册 tools(裸 pi 优雅退化,
 *    不注册 = agent 看不到这些 tool);
 * 2. tools 目录的 6 个 tool 定义一次性注册进 pi。
 */
import { callDesktop, type ExtensionApi, type ToolDefinition } from "./runtime";
import { busStatusTool } from "./tools/bus-status";
import { sessionCreateTool } from "./tools/session-create";
import { sessionAbortTool } from "./tools/session-abort";
import { channelMemberTool } from "./tools/channel-member";
import { tapStartTool } from "./tools/tap-start";
import { tapStopTool } from "./tools/tap-stop";

const TOOLS: ToolDefinition[] = [
  busStatusTool,
  sessionCreateTool,
  sessionAbortTool,
  channelMemberTool,
  tapStartTool,
  tapStopTool,
];

export function setupBus(pi: ExtensionApi): void {
  let pinged = false;
  let registered = false;
  pi.on("session_start", () => {
    if (pinged) return;
    pinged = true;
    callDesktop("ping", {}, 1500)
      .then(() => {
        if (registered) return;
        registered = true;
        for (const tool of TOOLS) pi.registerTool(tool);
      })
      .catch(() => { /* desktop 不在:静默退化,agent 看不到这些 tool */ });
  });
}
