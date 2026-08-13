/**
 * 对话面板状态 —— 与任意会话(含已完成 subagent)来回对话的内存态。
 *
 * 需求拍板:两个 session 来回对话,而不是每次拉新的。机制全部走既有 bus 能力:
 * - 发:`bus.send("session:<key>", "chat", { text })` → 路由器 deliver → 目标会话
 *   input 钩子 transform 人话 → agent 处理并回复(回复落目标会话自己的文件/时间线)。
 * - 收:`tapStart({ session, filter: "stream" })` 订阅目标会话全量事件流,
 *   tap_event 帧经 ctx.bus.onMessage 收到 → 按 messageStart/Update/End 流式渲染。
 * - 继续对话(已完成/离线会话):`bus.send("desktop", "session_reopen", {cwd, sessionPath})`
 *   以已有文件起进程续上下文(不抢激活语义),再 tap。这条链让"拉出来的子 agent"
 *   结束后仍可接着聊,不用重新 spawn。
 * - 对话记录不落父会话时间线(卡片已收起,父会话保持干净);子会话文件天然有完整对话,
 *   切过去即可见。
 *
 * 状态模块级持有(同 orchestrator-singleton 模式),组件只读快照 + 订阅变更。
 */
import type { PluginContext, SessionBusMessage } from "@pi-desktop/contract";
import { messageContentText } from "@pi-desktop/contract";

export interface DialogMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

export interface DialogTarget {
  /** session:<key> 总线地址。 */
  addr: string;
  sessionPath?: string;
  name?: string;
  cwd?: string;
}

interface DialogState {
  open: boolean;
  target: DialogTarget | null;
  messages: DialogMsg[];
  tapId: string | null;
  busy: boolean;
  /** reopen 失败等一次性提示。 */
  error?: string;
}

let state: DialogState = { open: false, target: null, messages: [], tapId: null, busy: false };
const listeners = new Set<() => void>();
/** desktop op(bus_response 回投递)的挂起 Promise:replyTo 配对,超时/失败 resolve(null)。 */
const pendingOps = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
let messageUnsub: (() => void) | null = null;
/** 打开/关闭的单调序号:并发 openDialogFor 之间互斥(后发者胜,先发者放弃)。 */
let openSeq = 0;

export function subscribeDialog(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getDialogState(): Readonly<DialogState> {
  return state;
}

function notify(): void {
  for (const cb of listeners) cb();
}

function uuid(): string {
  return crypto.randomUUID();
}

/** 发 desktop op 并等 bus_response(插件面没有 direct op 封装,统一走 bus.send("desktop",...))。 */
function callDesktopOp(ctx: PluginContext, kind: string, payload: unknown, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve) => {
    const id = uuid();
    const timer = setTimeout(() => {
      pendingOps.delete(id);
      resolve(null);
    }, timeoutMs);
    pendingOps.set(id, { resolve, timer });
    ctx.bus?.send("desktop", kind, payload, id).catch(() => {
      clearTimeout(timer);
      pendingOps.delete(id);
      resolve(null);
    });
  });
}

/** 目标会话是否在线(进程活着,在 status 的运行中清单里)。 */
async function isSessionOnline(ctx: PluginContext, addr: string): Promise<boolean> {
  try {
    const status = (await ctx.bus?.status()) as { sessions?: { address: string }[] } | undefined;
    return (status?.sessions ?? []).some((s) => s.address === addr);
  } catch {
    return false;
  }
}

/** 打开(或切换)与某会话的对话面板:停旧 tap → 设目标 → 载入历史 → 离线则 reopen → 起新 tap。 */
export async function openDialogFor(ctx: PluginContext, target: DialogTarget): Promise<void> {
  const seq = ++openSeq;
  if (state.tapId && ctx.bus) await ctx.bus.tapStop(state.tapId).catch(() => {});
  if (seq !== openSeq) return; // 期间又开了别的目标:放弃本次,后发者继续
  state = { open: true, target, messages: [], tapId: null, busy: false, error: undefined };
  if (!messageUnsub && ctx.bus) messageUnsub = ctx.bus.onMessage(handleBusMessage);
  // 声明式揭示:emit 触发框架 tap → 展开右面板并激活「对话」Tab(贡献项 revealOn 同值)。
  ctx.events?.emit("subagent:dialog");
  notify();

  // 历史上下文:打开即读目标会话文件,把已有 user/assistant 消息带进面板
  // (纯文件读零 RPC;reopen 是续同一文件,历史不丢)。取最后 N 条,太长只取尾段。
  if (target.sessionPath) {
    const detail = await ctx.sessions.openSession(target.sessionPath).catch(() => null);
    if (seq !== openSeq || !state.open || state.target?.addr !== target.addr) return;
    if (detail) {
      const history = detail.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-30)
        .map((m) => ({ id: m.id ?? crypto.randomUUID(), role: m.role as "user" | "assistant", text: messageContentText(m.content) }));
      if (history.length) state.messages = history;
    }
  }

  // 已完成/离线会话:reopen 起进程续上下文(继续对话的入口)。
  if (target.sessionPath && target.cwd) {
    const online = await isSessionOnline(ctx, target.addr);
    if (!online) {
      const res = (await callDesktopOp(ctx, "session_reopen", { cwd: target.cwd, sessionPath: target.sessionPath })) as
        { session?: string; key?: string; sessionPath?: string } | null;
      // 并发切换校验:用户已点别的目标则放弃本次结果
      if (seq !== openSeq || !state.open || state.target?.addr !== target.addr) return;
      if (res?.session) state.target = { ...state.target, addr: res.session };
      else state.error = "reopen_failed";
    }
  }
  if (seq !== openSeq || !state.open || !state.target) return;
  const tap = (await ctx.bus?.tapStart({ session: state.target.addr, filter: "stream" }).catch(() => null)) as
    { tapId?: string } | null;
  if (seq === openSeq && state.open && tap?.tapId) state.tapId = tap.tapId;
  notify();
}

/** 关闭面板:停 tap,清状态。onMessage 监听保持挂载(下次打开复用)。 */
export async function closeDialog(ctx: PluginContext): Promise<void> {
  openSeq += 1; // 关闭后任何 in-flight 的 openDialogFor 都放弃恢复
  if (state.tapId && ctx.bus) await ctx.bus.tapStop(state.tapId).catch(() => {});
  state = { open: false, target: null, messages: [], tapId: null, busy: false };
  notify();
}

/** 发一条消息到目标会话(kind "chat" → 路由器按事件帧 followUp 排队,不打断目标当前 turn)。 */
export async function sendDialogMessage(ctx: PluginContext, text: string): Promise<void> {
  if (!state.open || !state.target) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  state.messages.push({ id: uuid(), role: "user", text: trimmed });
  state.busy = true;
  notify();
  try {
    await ctx.bus?.send(state.target.addr, "chat", { text: trimmed });
  } catch {
    state.error = "send_failed";
    state.busy = false;
    notify();
  }
}

/** 面板的消息流文本提取(NeutralMessage.content → 纯文本)。 */
function textOf(message: { content?: unknown } | undefined): string {
  try {
    return message ? messageContentText(message.content) : "";
  } catch {
    return "";
  }
}

function handleBusMessage(msg: SessionBusMessage): void {
  if (msg.kind === "bus_response" && msg.replyTo) {
    const p = pendingOps.get(msg.replyTo);
    if (p) {
      pendingOps.delete(msg.replyTo);
      clearTimeout(p.timer);
      p.resolve(msg.payload);
    }
    return;
  }
  if (msg.kind !== "tap_event" || !state.open || !state.tapId) return;
  const payload = (msg.payload ?? {}) as {
    tapId?: string; eventType?: string; event?: { message?: { content?: unknown; role?: unknown } };
  };
  if (payload.tapId !== state.tapId) return;
  const { eventType, event } = payload;
  if (eventType === "messageStart") {
    state.messages.push({ id: uuid(), role: "assistant", text: "", streaming: true });
    state.busy = true;
    notify();
    return;
  }
  if (eventType === "messageUpdate" || eventType === "messageEnd") {
    const text = textOf(event?.message);
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === "assistant") {
      last.text = text || last.text;
      if (eventType === "messageEnd") {
        last.streaming = false;
        state.busy = false;
      }
      notify();
    }
    return;
  }
  if (eventType === "agentStart") {
    state.busy = true;
    notify();
    return;
  }
  if (eventType === "agentSettled") {
    state.busy = false;
    notify();
  }
}
