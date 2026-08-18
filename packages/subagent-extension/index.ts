/**
 * subagent-extension —— pi 底座 extension:subagent 的 agent 侧能力面(入口接线层)。
 *
 * 设计:docs/design/subagent-scheduling.md。本文件只做三件事:
 * 1. input 钩子——认领 subagent 私域帧:bus_response(replyTo 命中 pending)handled 吞帧
 *    恢复同步 tool 语义;subagent_done/subagent_note transform 人话化进 agent 上下文。
 *    其余 $bus 帧一律放行(chat/tap_event 等归 bus-extension 的钩子,互不抢帧)。
 * 2. session_start 自感知——读自己 session 头行(tool-gate 同手法,8KB 窗口):发现
 *    custom-my-harness-desktop.subagent 域且 allowSpawn!==true → 我是子,不注册 spawn 系 tool。
 *    注意这是一层体验优化(tool 清单干净),不是权威闸——session_start 时插件可能还没
 *    写完头行(子的 task 注入早于头行写入,设计 §4.3),递归的权威校验在插件编排层
 *    (请求方在活跃子账上且未声明 allowSpawn → 拒绝)。
 * 3. ping 探测编排者——sub-agent 桌面插件在线才注册 5 个 tool(裸 pi / 无插件环境
 *    优雅退化:不注册 = agent 看不到这些 tool,不存在"调了但失败")。
 *
 * 机制(窄类型/pending/帧读写/formatFrame)在 runtime.ts;tool 定义一文件一个在 tools/。
 * 交付:client/pi/subagent-extension-installer.ts 在 app 启动时同步本目录到
 * ~/.pi/agent/extensions/subagent-extension/(index.ts + runtime.ts + tools/,jiti 解析相对 import)。
 */
import * as fs from "node:fs";
import {
  callOrchestrator, formatFrame, takePending,
  type BusFrame, type ExtensionApi, type SessionStartContext, type ToolDefinition,
} from "./runtime";
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

export default function (pi: ExtensionApi): void {
  pi.on("input", (event) => {
    const raw = event?.text;
    if (typeof raw !== "string" || !raw.startsWith("{")) return;
    let frame: BusFrame;
    try {
      frame = JSON.parse(raw) as BusFrame;
    } catch {
      return;
    }
    if (frame?.$bus !== true) return;
    if (event.source && event.source !== "rpc") return; // 人类手敲的 $bus JSON 透传
    if (frame.kind === "bus_response" && typeof frame.replyTo === "string") {
      const resolve = takePending(frame.replyTo);
      if (resolve) {
        resolve(frame.payload);
        return { action: "handled" };
      }
      return; // 命中的是 bus-extension 的 pending,放行给它
    }
    if (frame.kind === "subagent_done" || frame.kind === "subagent_note") {
      return { action: "transform", text: formatFrame(frame), images: event.images };
    }
    return; // chat/tap_event 等归 bus-extension 的钩子
  });

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
