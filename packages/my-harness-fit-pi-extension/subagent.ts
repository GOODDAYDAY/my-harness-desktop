/**
 * subagent 能力 —— subagent 的 agent 侧能力面(入口接线层)。
 * (原 packages/subagent-extension/index.ts;input 钩子已上提 index.ts 统一路由)
 *
 * 设计:docs/design/subagent-scheduling.md。本模块只做两件事:
 * 1. session_start 自感知——读自己 session 头行:发现 custom-my-harness-desktop.subagent 域
 *    且 allowSpawn!==true → 我是子,不注册 spawn 系 tool(体验层优化,权威闸在插件编排层);
 * 2. ping 探测编排者——sub-agent 桌面插件在线才注册 5 个 tool(裸 pi 优雅退化)。
 */
import * as fs from "node:fs";
import { callOrchestrator, type ExtensionApi, type SessionStartContext, type ToolDefinition } from "./runtime";
import { spawnSubagentTool } from "./tools/spawn-subagent";
import { listSubagentsTool } from "./tools/list-subagents";
import { waitSubagentTool } from "./tools/wait-subagent";
import { sendToSubagentTool } from "./tools/send-to-subagent";
import { abortSubagentTool } from "./tools/abort-subagent";

const TOOLS: ToolDefinition[] = [
  spawnSubagentTool,
  listSubagentsTool,
  waitSubagentTool,
  sendToSubagentTool,
  abortSubagentTool,
];

interface SubagentDomain {
  allowSpawn?: boolean;
}

/** 读会话文件头行的 custom-my-harness-desktop.subagent 域。读不到/没有域 = 普通会话(null)。 */
function readSubagentDomain(sessionFile: string): SubagentDomain | null {
  let fd: number;
  try {
    fd = fs.openSync(sessionFile, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    const head = buf.subarray(0, n).toString("utf8");
    const nl = head.indexOf("\n");
    const header = JSON.parse(nl < 0 ? head : head.slice(0, nl)) as Record<string, unknown>;
    const custom = header["custom-my-harness-desktop"] as Record<string, unknown> | undefined;
    return (custom?.subagent as SubagentDomain | undefined) ?? null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function setupSubagent(pi: ExtensionApi): void {
  let probed = false;
  pi.on("session_start", (_event, ctx: SessionStartContext) => {
    if (probed) return;
    probed = true;
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    const sub = sessionFile ? readSubagentDomain(sessionFile) : null;
    if (sub && sub.allowSpawn !== true) return; // 子:体验层不注册(权威闸在插件编排层)
    void callOrchestrator("subagent_ping", {}, 1500)
      .then(() => { for (const tool of TOOLS) pi.registerTool(tool); })
      .catch(() => { /* 编排者不在:静默退化,agent 看不到这些 tool */ });
  });
}
