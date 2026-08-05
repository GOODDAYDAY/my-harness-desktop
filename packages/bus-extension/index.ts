/**
 * bus-extension —— pi 底座 extension:Session Bus 的 agent 侧能力面(入口接线层)。
 *
 * 设计:docs/design/session-bus.md。本文件只做三件事:
 * 1. input 钩子——信封识别($bus + source 辅助):响应帧(replyTo 命中 pending)handled
 *    吞掉恢复同步 tool 语义,事件帧 transform 人话化进 agent 上下文;
 * 2. session_start 时 ping 探测 desktop,有 desktop 才注册 tools(裸 pi 优雅退化,
 *    不注册 = agent 看不到这些 tool);
 * 3. tools 目录的 6 个 tool 定义一次性注册进 pi。
 *
 * 机制(窄类型/pending/帧读写/formatFrame)在 runtime.ts;tool 定义一文件一个在 tools/。
 * 交付:client/pi/bus-extension-installer.ts 在 app 启动时同步本目录到
 * ~/.pi/agent/extensions/bus-extension/(index.ts + tools/,相对 import 经 jiti 解析)。
 */
import { randomUUID } from "node:crypto";
import {
  emitFrame, formatFrame, putPending, takePending,
  type BusFrame, type ExtensionApi, type ToolDefinition,
} from "./runtime";
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

export default function (pi: ExtensionApi): void {
  // input 钩子:信封识别 → 响应帧 handled 吞帧 resolve,事件帧 transform 人话化
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
    if (event.source && event.source !== "rpc") return; // 人类手敲的 $bus JSON 透传,不吞不改写
    if (frame.kind === "bus_response" && typeof frame.replyTo === "string") {
      const resolve = takePending(frame.replyTo);
      if (resolve) {
        resolve(frame.payload);
        return { action: "handled" };
      }
      return; // 命中的是别家 pending(如 subagent_ping 的应答),放行不吞——input 钩子是
              // 链式传递(runner emitInput:transform 的输出是下一家的输入),此处若落到
              // transform,raw JSON 被格式化成展示文本,下游钩子的 takePending 永远落空
    }
    return { action: "transform", text: formatFrame(frame), images: event.images };
  });

  // ping 探测:有 desktop 才注册 tools;裸 pi 优雅退化
  let pinged = false;
  let registered = false;
  pi.on("session_start", () => {
    if (pinged) return;
    pinged = true;
    const id = randomUUID();
    putPending(id, () => {
      if (registered) return;
      registered = true;
      for (const tool of TOOLS) pi.registerTool(tool);
    }, 1500);
    emitFrame({ $bus: true, id, to: "desktop", kind: "ping", payload: {}, timestamp: Date.now() });
  });
}
