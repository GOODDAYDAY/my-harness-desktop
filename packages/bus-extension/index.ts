/**
 * bus-extension —— pi 底座 extension:Session Bus 的 agent 侧能力面。
 *
 * 设计:docs/design/session-bus.md §5。职责四件:
 * 1. 注册 6 个设置层 tool(bus_status/session_create/session_abort/channel_member/tap_start/tap_stop);
 *    IM 范式下"发消息"不是 tool——agent 在房间里说话,desktop 按成员关系自动 fan-out;
 *    bus_send 已退役(agent 有天然嗓子,send 是让 agent 用 API 复述自己刚说过的话);
 *    一轮工具调用能把一个编排动作整明白(设计底线:查询一轮,执行/订阅各一轮);
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

/** 事件帧 → 可读文本(transform 进 agent 上下文)。chat 帧附"可闭嘴"软约定(§3.4)。 */
function formatFrame(frame: BusFrame): string {
  const head = `[bus ${frame.kind}] from=${frame.from ?? "?"} to=${frame.to}${frame.replyTo ? ` replyTo=${frame.replyTo}` : ""}`;
  if (frame.kind === "chat") {
    const said = (frame.payload as { text?: string } | undefined)?.text ?? JSON.stringify(frame.payload ?? "");
    return `${head}\n${said}\n(来自房间的转发——有新内容才回复,不回复是合法选项)`;
  }
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

function registerAllTools(apiRef: ExtensionApi): void {
  api = apiRef;

  defTool("bus_status", "ONE call for the full bus picture: who I am (address/channels/taps), all running sessions (address/name/cwd/busy), all channels with members. Always call this first when planning orchestration.",
    {}, [], () => opCall("bus_status", {}));

  defTool("session_create", "Spawn a NEW pi session (independent process, own context) and optionally give it a task in ONE call. task: injected as first prompt immediately. watch=true: you get session_done with the COMPLETE final output when it finishes. channels: the new session auto-joins these rooms (created if missing). Use for delegating work to sub-agents — task + watch + channels covers a full dispatch in one round.",
    {
      task: { type: "string", description: "First prompt to inject (task description)" },
      cwd: { type: "string", description: "Working directory (default: caller's cwd)" },
      name: { type: "string", description: "Session display name" },
      model: { type: "object", description: "{provider, modelId} override (default: inherit)" },
      toolConfig: { type: "object", description: "{mode, enabledToolIds?} tool restriction" },
      watch: { type: "boolean", description: "Notify me with full output when done" },
      channels: { type: "array", items: { type: "string" }, description: "Rooms the new session auto-joins" },
    }, [],
    (p) => opCall("session_create", p));

  defTool("session_abort", "Stop a session process (self or others). Watchers get session_done with status=aborted; rooms get peer_left.",
    { session: addr }, ["session"],
    (p) => opCall("session_abort", p));

  defTool("channel_member", "Join or leave a channel (action: join | leave). member defaults to yourself — pass another session address to broker it in/out. Channels are created on first join and dissolve when empty.",
    {
      channel: { type: "string" },
      action: { type: "string", description: "join | leave" },
      member: { ...addr, description: "Address to join/remove (default: self)" },
    }, ["channel", "action"],
    (p) => opCall("channel_member", p));

  defTool("tap_start", "Observe a session's events or a channel's message flow (read-only). filter: done (default, completion signal only) | lifecycle (+ boundary events) | stream (all events, plugin targets only). deliverTo defaults to yourself; pass a third-party address to broker observation. Completion always delivers session_done with the FULL final output. Returns tapId.",
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
