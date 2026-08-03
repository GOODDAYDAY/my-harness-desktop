/**
 * bus-extension 共享机制层 —— 窄类型、请求-响应回路(pending Map 单例)、帧读写与格式化。
 *
 * index.ts(input 钩子/ping)与 tools/*.ts(各 tool 的 execute)都经这里拿机制;
 * 模块作用域的 pending Map 经 Node 模块缓存天然单例——上行响应(input 钩子 resolve)
 * 和下行请求(tools 的 callDesktop 挂起)看到同一张表。
 * 类型不 import 官方 pi 包(够不到)——手写窄结构,与 toolgate 同一手法。
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

export interface ExtensionApi {
  on(event: "input", handler: (event: InputEvent, ctx: unknown) => InputResult): void;
  on(event: "session_start", handler: (event: unknown, ctx: unknown) => void): void;
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

/** 地址参数的 JSON Schema(tools 间共享,防各处手写漂移)。 */
export const ADDR_PROP = { type: "string", description: "Bus address: session:<key> | channel:<name> | plugin:<id>" };

const pending = new Map<string, { resolve: (payload: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

/** input 钩子用:按 replyTo 取挂起的 Promise 并清除(命中即吞帧)。 */
export function takePending(replyTo: string): ((payload: unknown) => void) | null {
  const p = pending.get(replyTo);
  if (!p) return null;
  pending.delete(replyTo);
  clearTimeout(p.timer);
  return p.resolve;
}

/** ping 用:登记一个一次性 pending(超时会触发清理回调)。 */
export function putPending(id: string, resolve: (payload: unknown) => void, timeoutMs: number): void {
  const timer = setTimeout(() => { pending.delete(id); }, timeoutMs);
  pending.set(id, { resolve, timer });
}

/** 上行:往 desktop 写一帧(process.stdout;desktop 的 rpc-adapter $bus 分支收)。 */
export function emitFrame(frame: Omit<BusFrame, "from">): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

/** desktop op 调用:发请求 + 挂起等 bus_response(input 钩子 resolve)。 */
export function callDesktop(op: string, payload: unknown, timeoutMs = 60000): Promise<unknown> {
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

export function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/** tool execute 的统一出口:op 调用 + 错误文本化(agent 拿到错误自己决策)。 */
export async function opCall(op: string, payload: unknown): Promise<ToolResult> {
  try {
    return text(await callDesktop(op, payload));
  } catch (err) {
    return text(`错误: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 事件帧 → 可读文本(transform 进 agent 上下文)。chat 帧附"可闭嘴"软约定(§3.4)。 */
export function formatFrame(frame: BusFrame): string {
  const head = `[bus ${frame.kind}] from=${frame.from ?? "?"} to=${frame.to}${frame.replyTo ? ` replyTo=${frame.replyTo}` : ""}`;
  if (frame.kind === "chat") {
    const said = (frame.payload as { text?: string } | undefined)?.text ?? JSON.stringify(frame.payload ?? "");
    return `${head}\n${said}\n(来自房间的转发——有新内容才回复,不回复是合法选项)`;
  }
  const body = frame.payload === undefined ? "" : `\n${JSON.stringify(frame.payload, null, 2)}`;
  return head + body;
}
