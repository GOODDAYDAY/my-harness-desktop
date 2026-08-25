/**
 * my-harness-fit-pi-extension 共享机制层 —— 统一了原 bus-extension / subagent-extension 两套
 * 近重复的窄类型 / pending Map / 帧读写 / 格式化,并补上 toolgate / context-probe / skills 用到的窄类型。
 *
 * 契约单源:一处定义,index.ts / toolgate.ts / context-probe.ts / bus.ts / subagent.ts /
 * skills.ts / tools/*.ts 都从本文件拿机制,不再各处手写漂移。
 *
 * 与原两套 runtime 的关键收敛:
 * - pending Map 合并为单例:bus 与 subagent 的请求都按 randomUUID 的 replyTo 配对,
 *   id 无碰撞,一张表即可——消掉"两个 input 钩子链式传递、谁先谁后"的时序脆弱。
 * - callDesktop / callOrchestrator 收敛到 callBus(to, ...),仅 to 地址与错误文案不同。
 * - formatFrame 收敛为 kind 分派:subagent_done/subagent_note 人话化,chat 走对话文案,其余走 bus 通用帧。
 *
 * 类型不 import 官方 pi 包(类型包在内核 node_modules,仓库 tsconfig 够不到)——手写窄结构。
 */
import { randomUUID } from "node:crypto";

// ---- 通用工具结果 / 定义 ----
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

// ---- input 事件 / 结果 ----
export interface InputEvent {
  text?: string;
  images?: unknown[];
  source?: string;
}

export type InputResult = { action: "handled" } | { action: "transform"; text: string; images?: unknown[] } | void;

// ---- 会话上下文 ----
export interface SessionStartContext {
  sessionManager?: { getSessionFile(): string | undefined };
}

// ---- pi 内核 API 超集(各能力模块各取所需) ----
export interface ExtensionApi {
  on(event: "input", handler: (event: InputEvent, ctx: unknown) => InputResult): void;
  on(event: "session_start", handler: (event: unknown, ctx: SessionStartContext) => void): void;
  on(event: "turn_start", handler: (event: unknown, ctx: SessionStartContext) => void): void;
  on(event: "before_provider_request", handler: (event: { payload?: unknown }, ctx: SessionStartContext) => unknown): void;
  registerTool(tool: ToolDefinition): void;
  setActiveTools(toolNames: string[]): void;
  getAllTools(): ToolInfoNarrow[];
}

// ---- 工具清单播报窄类型(toolgate 能力) ----
export interface ToolInfoNarrow {
  name: string;
  description?: string;
  sourceInfo?: { source?: string; path?: string };
}

export interface AnnouncedTool {
  name: string;
  description: string;
  source: "builtin" | "extension";
  extensionPath?: string;
}

export interface SessionToolConfig {
  enabledGroupIds?: string[];
  enabledToolIds?: string[];
}

// ---- $bus 帧 ----
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

// ---- 地址 / 常量 ----
/** 地址参数的 JSON Schema(tools 间共享,防各处手写漂移)。 */
export const ADDR_PROP = { type: "string", description: "Bus address: session:<key> | channel:<name> | plugin:<id>" };

/** 桌面路由器地址(bus 系请求的接收方;rpc-adapter 的 $bus 分支收帧)。 */
export const DESKTOP_ADDR = "desktop";

/** 编排者总线地址(= sub-agent 桌面插件的 manifest id)。契约单源:插件侧同名字面量。 */
export const ORCHESTRATOR_ADDR = "plugin:sub-agent";

/**
 * wait 系调用的挂起上限。权威期限是插件的子超时闸(配置项,默认 10min)——闸到点必交付终态,
 * 这里留足余量(16min)只防"插件异常死没回"的挂死。超时 reject 后晚到的 bus_response 因
 * pending 已删而吞不掉,降级为一条丑 JSON 进上下文——可接受,不死等。
 */
export const WAIT_TIMEOUT_MS = 16 * 60_000;

// ---- 请求-响应回路(共享 pending Map 单例) ----
const pending = new Map<string, { resolve: (payload: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

/** input 钩子用:按 replyTo 取挂起的 Promise 并清除(命中即吞帧)。 */
export function takePending(replyTo: string): ((payload: unknown) => void) | null {
  const p = pending.get(replyTo);
  if (!p) return null;
  pending.delete(replyTo);
  clearTimeout(p.timer);
  return p.resolve;
}

/** 上行:往 stdout 写一帧(desktop 的 rpc-adapter $bus 分支收 → 路由器)。 */
export function emitFrame(frame: Omit<BusFrame, "from">): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

/** 发请求 + 挂起等 bus_response(input 钩子 resolve)。to 是接收方地址。 */
export function callBus(to: string, kind: string, payload: unknown, timeoutMs = 60_000): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bus 响应超时(${Math.round(timeoutMs / 1000)}s):${to} 未应答 ${kind}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    emitFrame({ $bus: true, id, to, kind, payload, timestamp: Date.now() });
  });
}

/** 调桌面路由器(bus 系 op)。 */
export const callDesktop = (op: string, payload: unknown, timeoutMs = 60_000): Promise<unknown> =>
  callBus(DESKTOP_ADDR, op, payload, timeoutMs);

/** 调编排者(subagent 系 op)。 */
export const callOrchestrator = (kind: string, payload: unknown, timeoutMs = 60_000): Promise<unknown> =>
  callBus(ORCHESTRATOR_ADDR, kind, payload, timeoutMs);

export function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/** bus 系 tool 的统一出口:桌面 op 调用 + 错误文本化(agent 拿到错误自己决策)。 */
export async function busOpCall(op: string, payload: unknown, timeoutMs?: number): Promise<ToolResult> {
  try {
    return text(await callDesktop(op, payload, timeoutMs));
  } catch (err) {
    return text(`错误: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** subagent 系 tool 的统一出口:编排者调用 + 错误文本化。 */
export async function subagentOpCall(kind: string, payload: unknown, timeoutMs?: number): Promise<ToolResult> {
  try {
    return text(await callOrchestrator(kind, payload, timeoutMs));
  } catch (err) {
    return text(`错误: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 事件帧 → 可读文本(transform 进 agent 上下文)。kind 分派:
 * subagent 私域帧(subagent_done/subagent_note)人话化;chat 帧附"可闭嘴"软约定;
 * 其余(bus_status/tap_event 等)走 bus 通用帧。定向对话(来自 plugin)与房间转发区分文案。
 */
export function formatFrame(frame: BusFrame): string {
  const p = (frame.payload ?? {}) as Record<string, unknown>;
  if (frame.kind === "subagent_done") {
    const title = p.name ?? p.task ?? p.subagent ?? "?";
    return `【子 agent 完成】任务:${title}\n状态:${p.status ?? "?"}\n${typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "")}`;
  }
  if (frame.kind === "subagent_note") {
    return `【父 agent 追加指令】${typeof p.text === "string" ? p.text : JSON.stringify(p)}`;
  }
  const head = `[bus ${frame.kind}] from=${frame.from ?? "?"} to=${frame.to}${frame.replyTo ? ` replyTo=${frame.replyTo}` : ""}`;
  if (frame.kind === "chat") {
    const said = (frame.payload as { text?: string } | undefined)?.text ?? JSON.stringify(frame.payload ?? "");
    if (frame.from?.startsWith("plugin:")) {
      return `${head}\n${said}\n(来自桌面对话面板的消息——请直接回复)`;
    }
    return `${head}\n${said}\n(来自房间的转发——有新内容才回复,不回复是合法选项)`;
  }
  const body = frame.payload === undefined ? "" : `\n${JSON.stringify(frame.payload, null, 2)}`;
  return head + body;
}
