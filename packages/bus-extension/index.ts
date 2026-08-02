/**
 * bus-extension —— pi 底座 extension:Session Bus 的 agent 侧能力面。
 *
 * 设计:docs/design/session-bus.md §5。职责四件:
 * 1. 注册 14 个编排 tool(session_create、bus_send、channel 系、tap 系等)——agent 像调 bash 一样调它们;
 * 2. 上行:tool 调用 → stdout 写 $bus 帧(desktop 的 rpc-adapter 收);
 * 3. 下行:input 钩子识别 $bus 信封——响应帧(replyTo 命中 pending)handled 吞掉恢复同步 tool 语义,
 *    事件帧 transform 成可读文本进 agent 上下文;
 * 4. session_start 时 ping 探测 desktop,无 desktop(裸 pi 命令行)则不注册任何 tool,优雅退化。
 *
 * 交付:client/pi/bus-extension-installer.ts 在 app 启动时同步到 ~/.pi/agent/extensions/bus-extension/。
 * 类型不 import 官方 pi 包(够不到)——手写窄结构,与 toolgate 同一手法。
 */
import { randomUUID } from "node:crypto";

// ---- 窄类型(只覆盖本扩展用到的 pi extension API 面) ----

interface ToolResult {
  content: { type: "text"; text: string }[];
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<ToolResult>;
}

interface InputEvent {
  text?: string;
  images?: unknown[];
  source?: string;
}

type InputResult = { action: "handled" } | { action: "transform"; text: string; images?: unknown[] } | void;

interface ExtensionApi {
  on(event: "input", handler: (event: InputEvent, ctx: unknown) => InputResult): void;
  on(event: "session_start", handler: (event: unknown, ctx: unknown) => void): void;
  registerTool(tool: ToolDefinition): void;
}

interface BusFrame {
  $bus: true;
  id: string;
  from?: string;
  to: string;
  kind: string;
  payload?: unknown;
  timestamp: number;
  replyTo?: string;
}

// ---- 状态:pending Map(请求-响应配对)+ desktop 可用性 ----

const pending = new Map<string, { resolve: (payload: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
let desktopReady = false;
const registered: string[] = [];

/** 上行:往 desktop 写一帧(process.stdout;desktop 的 rpc-adapter $bus 分支收)。 */
function emitFrame(frame: Omit<BusFrame, "from">): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

/** desktop op 调用:发请求 + 挂起等 bus_response(input 钩子 resolve)。 */
function callDesktop(op: string, payload: unknown, timeoutMs = 60000): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bus 响应超时(${timeoutMs / 1000}s):desktop 未应答 ${op}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    emitFrame({ $bus: true, id, to: "desktop", kind: op, payload, timestamp: Date.now() });
  });
}

/** 纯路由消息:不等响应,发完即回。 */
function sendFrame(to: string, kind: string, payload: unknown, replyTo?: string): ToolResult {
  emitFrame({ $bus: true, id: randomUUID(), to, kind, payload, timestamp: Date.now(), replyTo });
  return text({ delivered: to });
}

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

async function opCall(op: string, payload: unknown): Promise<ToolResult> {
  try {
    return text(await callDesktop(op, payload));
  } catch (err) {
    return text(`错误: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 事件帧 → 可读文本(transform 进 agent 上下文)。 */
function formatFrame(frame: BusFrame): string {
  const head = `[bus ${frame.kind}] from=${frame.from ?? "?"} to=${frame.to}${frame.replyTo ? ` replyTo=${frame.replyTo}` : ""}`;
  const body = frame.payload === undefined ? "" : `\n${JSON.stringify(frame.payload, null, 2)}`;
  return head + body;
}

// ---- tool 注册(14 个;desktopReady 后一次性注册) ----

function defTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  handler: (p: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
): void {
  if (registered.includes(name)) return;
  registered.push(name);
  api.registerTool({
    name,
    label: name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    execute: async (_id, params) => handler(params),
  });
}

const addr = { type: "string", description: "Bus address: session:<key> | channel:<name> | plugin:<id>" };
const kindProp = { type: "string", description: "Message kind (open string, default \"chat\")" };
const payloadProp = { description: "Payload (any JSON value)" };

function registerAllTools(apiRef: ExtensionApi): void {
  api = apiRef;

  defTool("bus_whoami", "My bus identity: own address, channel memberships, active taps. Call before planning orchestration.", {}, [], () => opCall("bus_whoami", {}));

  defTool("bus_sessions", "List all running sessions: address, name, cwd, busy state. Optional filter by cwd or name prefix.",
    { filter: { type: "string", description: "Optional cwd/name prefix filter" } }, [],
    (p) => opCall("bus_sessions", p));

  defTool("session_create", "Spawn a NEW pi session (independent process with its own context). Returns its bus address. With task: the task is injected as the first prompt immediately. With watch=true: you receive a session_done event with the COMPLETE final output when it finishes. Use for delegating work to sub-agents.",
    {
      task: { type: "string", description: "First prompt to inject (task description)" },
      cwd: { type: "string", description: "Working directory (default: caller's cwd)" },
      name: { type: "string", description: "Session display name" },
      model: { type: "object", description: "{provider, modelId} override (default: inherit)" },
      toolConfig: { type: "object", description: "{mode, enabledToolIds?} tool restriction" },
      watch: { type: "boolean", description: "Notify me with full output when done" },
    }, [],
    (p) => opCall("session_create", p));

  defTool("session_abort", "Stop a session process (self or others). Watchers get session_done with status=aborted.",
    { session: addr }, ["session"],
    (p) => opCall("session_abort", p));

  defTool("bus_send", "Send a message to any bus address (unicast). The recipient agent receives it as a readable message and can reply.",
    { to: addr, kind: kindProp, payload: payloadProp }, ["to"],
    (p) => sendFrame(String(p.to), typeof p.kind === "string" ? p.kind : "chat", p.payload));

  defTool("bus_publish", "Publish a message to a channel: all members except yourself receive it. Also used for broadcast.",
    { channel: { type: "string", description: "Channel name (without prefix)" }, kind: kindProp, payload: payloadProp }, ["channel"],
    (p) => sendFrame(`channel:${String(p.channel)}`, typeof p.kind === "string" ? p.kind : "chat", p.payload));

  defTool("bus_reply", "Reply to a received bus message (correlates via replyTo = the original message id).",
    { to: addr, replyTo: { type: "string", description: "id of the message being replied to" }, payload: payloadProp }, ["to", "replyTo"],
    (p) => sendFrame(String(p.to), "chat", p.payload, String(p.replyTo)));

  defTool("channel_join", "Join a channel (member defaults to yourself; you may join another session to broker it). Created on first join.",
    { channel: { type: "string" }, member: { ...addr, description: "Address to join (default: self)" } }, ["channel"],
    (p) => opCall("channel_join", p));

  defTool("channel_leave", "Leave a channel (member defaults to yourself).",
    { channel: { type: "string" }, member: { ...addr, description: "Address to remove (default: self)" } }, ["channel"],
    (p) => opCall("channel_leave", p));

  defTool("channel_members", "List current members of a channel.",
    { channel: { type: "string" } }, ["channel"],
    (p) => opCall("channel_members", p));

  defTool("channel_list", "List all active channels with member counts. Check before creating a new one.", {}, [], () => opCall("channel_list", {}));

  defTool("tap_start", "Observe a session's events or a channel's message flow (read-only). filter: done (default, completion only) | lifecycle (boundary events) | stream (all events, plugin targets only). deliverTo defaults to yourself; set a third-party address to broker observation. Returns tapId. Completion always delivers session_done with the FULL final output.",
    {
      session: { ...addr, description: "Session address to observe" },
      channel: { type: "string", description: "Channel name to observe (filter not applicable)" },
      filter: { type: "string", description: "done | lifecycle | stream" },
      deliverTo: { ...addr, description: "Where events go (default: self)" },
    }, [],
    (p) => opCall("tap_start", p));

  defTool("tap_stop", "Stop an active tap by tapId.",
    { tapId: { type: "string" } }, ["tapId"],
    (p) => opCall("tap_stop", p));

  defTool("tap_list", "List taps you created or that deliver to you.", {}, [], () => opCall("tap_list", {}));
}

// ---- 入口 ----

let api: ExtensionApi;

export default function (pi: ExtensionApi): void {
  api = pi;

  // input 钩子:信封识别($bus + source 辅助)→ 响应帧 handled 吞帧 resolve,事件帧 transform 人话化
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
      const p = pending.get(frame.replyTo);
      if (p) {
        pending.delete(frame.replyTo);
        clearTimeout(p.timer);
        p.resolve(frame.payload);
        return { action: "handled" };
      }
    }
    return { action: "transform", text: formatFrame(frame), images: event.images };
  });

  // ping 探测:有 desktop 才注册 tools;裸 pi 优雅退化(不注册 = agent 看不到这些 tool)
  let pinged = false;
  pi.on("session_start", () => {
    if (pinged) return;
    pinged = true;
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); }, 1500);
    pending.set(id, {
      resolve: () => {
        clearTimeout(timer);
        if (desktopReady) return;
        desktopReady = true;
        registerAllTools(api);
      },
      timer,
    });
    emitFrame({ $bus: true, id, to: "desktop", kind: "ping", payload: {}, timestamp: Date.now() });
  });
}
