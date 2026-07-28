// 会话投影 store(renderer 侧单一真相源)—— main SessionStore 投影的镜像。
//
// 数据流:main 推 session:snapshot(切换时一次基线)+ session:event(持续增量)。
// 本 store 应用增量,组件只读 store、永不各自 getSnapshot(消灭 3× 重复拉取)。
// 模块级单例:首个组件挂载时 init 一次(幂等)。
import { create } from "zustand";
import type { NeutralMessage, SessionEvent, SyncSnapshot } from "@pi-desktop/core";
import { sessionEntryToNeutral } from "@pi-desktop/core";

export interface SessionStoreState {
  /** 投影基线(null = pi 未启动/未同步;文件读不产生基线) */
  snapshot: SyncSnapshot | null;
  /** 消息流(文件读基线 或 投影基线 + 事件流) */
  messages: NeutralMessage[];
  streaming: boolean;
  /** 切换会话中(乐观 UI:骨架/旧内容淡出) */
  switching: boolean;
  /** 可展示(有消息基线,不论来自文件还是 pi) */
  ready: boolean;
  /** 打开历史会话:纯文件读,秒开,不启 pi。 */
  openSession: (sessionPath: string) => Promise<void>;
  /** 新会话:本地清空,零 RPC;进程在首次发送时按需起。 */
  startNewChat: (cwd: string) => Promise<void>;
  /** 用户发消息后乐观回显(等 messageEnd(user) 到了去重) */
  appendOptimisticUser: (text: string) => void;
  /** 发送同时创建 assistant 占位(pending:true,content:'')消除空窗。
   *  pi 推 messageStart 时按 id 替换占位,messageUpdate 持续 patch。 */
  appendPendingAssistant: () => void;
}

/** 从消息 content 提取纯文本(去重乐观回显用)。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
      .map((c) => String((c as Record<string, unknown>).text ?? ""))
      .join("");
  }
  return "";
}

/** 事件增量应用(纯函数,便于测试)。
 *  按 messageId 精确 patch(L1.5 范式),不靠末条 role 替换。
 *  messageUpdate/messageEnd 的 event.message 带 id → find-by-id patch;
 *  找不到(id 不匹配,如 pi 直接推 messageUpdate 没经占位)→ 追加。 */
function applyEvent(messages: NeutralMessage[], event: SessionEvent): NeutralMessage[] {
  const msg = (event as { message?: NeutralMessage }).message;
  if (event.type === "messageUpdate" && msg) {
    // 按 id 精确 patch(优先);无 id 退回末条 role 替换(兼容底座不推 id 的场景)
    if (msg.id) {
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) return messages.map((m, i) => i === idx ? { ...m, ...msg, pending: false } : m);
    }
    // fallback:末条 assistant 替换(兼容)
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.pending) return [...messages.slice(0, -1), { ...msg, pending: false }];
    return [...messages, msg];
  }
  if (event.type === "messageStart" && msg) {
    // messageStart:底座开始推这条消息 → 找占位(pending:true)替换,或追加
    if (msg.id) {
      const idx = messages.findIndex(m => m.id === msg.id || (m.pending && m.role === msg.role));
      if (idx >= 0) return messages.map((m, i) => i === idx ? { ...m, ...msg, pending: true } : m);
    }
    return [...messages, { ...msg, pending: true }];
  }
  if (event.type === "messageEnd" && msg) {
    // 按 id 精确定稿(置 pending:false);无 id 退回末条 role 替换(兼容)
    if (msg.id) {
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) return messages.map((m, i) => i === idx ? { ...m, ...msg, pending: false, stopped: false } : m);
    }
    // fallback:末条同 role 替换(兼容)
    const last = messages[messages.length - 1];
    if (last && last.role === msg.role) return [...messages.slice(0, -1), { ...msg, pending: false }];
    // 乐观回显去重:末条 user 文本相同,替换
    if (last && last.role === "user" && msg.role === "user" && textOf(last.content) === textOf(msg.content)) {
      return [...messages.slice(0, -1), msg];
    }
    return [...messages, msg];
  }
  // entryAppended 只收元类型(分隔层);"message" 型由 messageEnd 通道进,防重复
  if (event.type === "entryAppended") {
    const entry = (event as { entry?: { type?: string } }).entry;
    if (entry && entry.type !== "message") {
      const neutral = sessionEntryToNeutral(entry);
      if (neutral) return [...messages, neutral];
    }
  }
  return messages;
}

export const useSessionStore = create<SessionStoreState>((set) => ({
  snapshot: null,
  messages: [],
  streaming: false,
  switching: false,
  ready: false,
  openSession: async (sessionPath) => {
    set({ switching: true });
    try {
      const detail = (await window.pi.sessions.openSession(sessionPath)) as {
        info?: { cwd?: string };
        messages?: NeutralMessage[];
      } | null;
      // 文件读即基线(秒开);同时记录发送上下文(cwd 取文件 header 的,最准)
      await window.pi.sessions.setContext(detail?.info?.cwd ?? "", sessionPath);
      set({
        messages: detail?.messages ?? [],
        snapshot: null,
        streaming: false,
        switching: false,
        ready: true,
      });
    } catch (err) {
      set({ switching: false });
      throw err;
    }
  },
  startNewChat: async (cwd) => {
    await window.pi.sessions.setContext(cwd, null);
    set({ messages: [], snapshot: null, streaming: false, switching: false, ready: true });
  },
  appendOptimisticUser: (text) => {
    set((s) => ({ messages: [...s.messages, { id: crypto.randomUUID(), role: "user", content: text }] }));
  },
  appendPendingAssistant: () => {
    set((s) => ({ messages: [...s.messages, { id: crypto.randomUUID(), role: "assistant", content: "", pending: true }] }));
  },
}));

let inited = false;
/** 初始化 main→renderer 通道(幂等;应用启动时调一次)。 */
export function initSessionStore(): void {
  if (inited) return;
  inited = true;

  window.pi.sessions.onSnapshot((snapshotRaw) => {
    const snapshot = snapshotRaw as SyncSnapshot;
    useSessionStore.setState({
      snapshot,
      messages: snapshot.messages ?? [],
      streaming: snapshot.state?.isStreaming ?? false,
      switching: false,
      ready: true,
    });
  });

  window.pi.sessions.onEvent((eventRaw) => {
    const event = eventRaw as SessionEvent;
    useSessionStore.setState((s) => ({
      messages: applyEvent(s.messages, event),
      streaming:
        event.type === "agentStart" ? true
        : event.type === "agentSettled" || event.type === "agentEnd" ? false
        : s.streaming,
      // 模型/思考强度变更也进基线 state(modelSelect 事件保持 pill 新鲜)
      snapshot: s.snapshot && event.type === "modelSelect" && (event as { model?: unknown }).model
        ? { ...s.snapshot, state: { ...s.snapshot.state, model: (event as { model?: never }).model } }
        : s.snapshot,
    }));
  });
}
