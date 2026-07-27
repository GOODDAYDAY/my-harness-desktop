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

/** 事件增量应用(纯函数,便于测试)。 */
function applyEvent(messages: NeutralMessage[], event: SessionEvent): NeutralMessage[] {
  const msg = (event as { message?: NeutralMessage }).message;
  if (event.type === "messageUpdate" && msg && msg.role === "assistant") {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") return [...messages.slice(0, -1), msg];
    return [...messages, msg];
  }
  if (event.type === "messageEnd" && msg) {
    const last = messages[messages.length - 1];
    // 流式定稿:末条同 role 替换
    if (last && last.role === msg.role && msg.role === "assistant") {
      return [...messages.slice(0, -1), msg];
    }
    // 乐观回显去重:末条 user 文本相同,替换(以底座版本为准)
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
    set((s) => ({ messages: [...s.messages, { role: "user", content: text }] }));
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
