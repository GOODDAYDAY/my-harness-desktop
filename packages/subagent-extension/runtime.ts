/**
 * subagent-extension 共享机制层 —— 与 bus-extension/runtime.ts 同模式:
 * 窄类型 / pending Map(模块缓存单例) / 帧读写 / 私域帧人话化。
 *
 * 与 bus-extension 的唯一形态差异:请求发往编排者(sub-agent 桌面插件,
 * to:"plugin:sub-agent" 经 bus 路由器广播进 renderer),不是 to:"desktop" 的路由器 op。
 * 响应回路不变:插件 bus.send 回 bus_response(replyTo 配对),input 钩子吞帧 resolve。
 *
 * 类型不 import 官方 pi 包(够不到)——手写窄结构,与 toolgate/bus-extension 同一手法。
 * 本目录由 client/pi/subagent-extension-installer.ts 同步到 ~/.pi/agent/extensions/subagent-extension/。
 */
import { randomUUID } from "node:crypto";

export interface ToolResult {
  content: { type: "text"; text: string }[];
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<ToolResult>;
}

export interface InputEvent {
  text?: string;
  images?: unknown[];
  source?: string;
}

export type InputResult = { action: "handled" } | { action: "transform"; text: string; images?: unknown[] } | void;

export interface SessionStartContext {
  sessionManager?: { getSessionFile(): string | undefined };
}

export interface ExtensionApi {
  on(event: "input", handler: (event: InputEvent, ctx: unknown) => InputResult): void;
  on(event: "session_start", handler: (event: unknown, ctx: SessionStartContext) => void): void;
  registerTool(tool: ToolDefinition): void;
}

export interface BusFrame {
  $bus: true;
  id: string;
  from?: string;
  to: string;
  kind: string;
  payload?: unknown;
  timestamp: number;
  replyTo?: string;
}

/** 编排者的总线地址(= sub-agent 桌面插件的 manifest id)。契约单源:插件侧同名字面量。 */
const ORCHESTRATOR_ADDR = "plugin:sub-agent";

/**
 * wait 系调用的挂起上限。权威期限是插件的子超时闸(配置项,默认 10min)——闸到点必交付终态,
 * 这里留足余量(16min)只防"插件异常死没回"的挂死。超时 reject 后晚到的 bus_response 因
 * pending 已删而吞不掉,降级为一条丑 JSON 进上下文——可接受,不死等。
 */
export const WAIT_TIMEOUT_MS = 16 * 60_000;

const pending = new Map<string, { resolve: (payload: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

/** input 钩子用:按 replyTo 取挂起的 Promise 并清除(命中即吞帧)。 */
export function takePending(replyTo: string): ((payload: unknown) => void) | null {
  const p = pending.get(replyTo);
  if (!p) return null;
  pending.delete(replyTo);
  clearTimeout(p.timer);
  return p.resolve;
}

/** 上行:往 stdout 写一帧(desktop rpc-adapter 的 $bus 分支收 → 路由器 → 编排者)。 */
export function emitFrame(frame: Omit<BusFrame, "from">): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

/** 调编排者:发帧 + 挂起等 bus_response(input 钩子 resolve)。 */
export function callOrchestrator(kind: string, payload: unknown, timeoutMs = 60_000): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`编排者响应超时(${Math.round(timeoutMs / 1000)}s):sub-agent 插件未应答 ${kind}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    emitFrame({ $bus: true, id, to: ORCHESTRATOR_ADDR, kind, payload, timestamp: Date.now() });
  });
}

export function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/** tool execute 的统一出口:编排者调用 + 错误文本化(agent 拿到错误自己决策)。 */
export async function opCall(kind: string, payload: unknown, timeoutMs?: number): Promise<ToolResult> {
  try {
    return text(await callOrchestrator(kind, payload, timeoutMs));
  } catch (err) {
    return text(`错误: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** subagent 私域事件帧 → 可读文本(transform 进 agent 上下文)。 */
export function formatFrame(frame: BusFrame): string {
  const p = (frame.payload ?? {}) as Record<string, unknown>;
  if (frame.kind === "subagent_done") {
    const title = p.name ?? p.task ?? p.subagent ?? "?";
    return `【子 agent 完成】任务:${title}\n状态:${p.status ?? "?"}\n${typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "")}`;
  }
  if (frame.kind === "subagent_note") {
    return `【父 agent 追加指令】${typeof p.text === "string" ? p.text : JSON.stringify(p)}`;
  }
  return `[subagent ${frame.kind}] ${JSON.stringify(frame.payload ?? {})}`;
}
