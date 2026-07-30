// 会话投影 store(renderer 侧单一真相源)—— main SessionStore 投影的镜像。
//
// 数据流:main 推 session:snapshot(切换时一次基线)+ session:event(持续增量)。
// 本 store 应用增量,组件只读 store、永不各自 getSnapshot(消灭 3× 重复拉取)。
// 模块级单例:首个组件挂载时 init 一次(幂等)。
import { create } from "zustand";
import type { NeutralMessage, SessionDetail, SessionEvent, SyncSnapshot, ModelInfo, SessionState } from "@pi-desktop/core";
import { sessionEntryToNeutral } from "@pi-desktop/core";
import { useUiStore } from "./ui-store";

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

function patchStateFromEvent(state: SessionState, event: SessionEvent): SessionState | null {
  switch (event.type) {
    case "modelSelect":
      return event.model ? { ...state, model: event.model as ModelInfo } : null;
    case "thinkingLevelChanged":
    case "thinkingLevelSelect": {
      const level = (event as { thinkingLevel?: string }).thinkingLevel;
      return level ? { ...state, thinkingLevel: level } : null;
    }
    case "agentStart":
      return { ...state, isStreaming: true };
    case "agentSettled":
    case "agentEnd":
      return { ...state, isStreaming: false };
    case "compactionStart":
      return { ...state, isCompacting: true };
    case "compactionEnd":
      return { ...state, isCompacting: false };
    case "sessionStart": {
      const sf = (event as { sessionFile?: string }).sessionFile;
      return sf ? { ...state, sessionFile: sf } : null;
    }
    case "sessionInfoChanged": {
      const name = (event as { sessionName?: string }).sessionName;
      return name ? { ...state, sessionName: name } : null;
    }
    case "queueUpdate": {
      const count = (event as { pendingMessageCount?: number }).pendingMessageCount;
      return count != null ? { ...state, pendingMessageCount: count } : null;
    }
    default:
      return null;
  }
}

/** 事件增量应用(纯函数,便于测试)。
 *  按 messageId 精确 patch(L1.5 范式),不靠末条 role 替换。
 *  messageUpdate/messageEnd 的 event.message 带 id → find-by-id patch;
 *  找不到(id 不匹配,如 pi 直接推 messageUpdate 没经占位)→ 追加。
 *
 *  pending 生命周期(单一语义:"该消息流式进行中",渲染层依此挂流式光标):
 *  置 true:占位(appendPendingAssistant)、messageStart、messageUpdate;
 *  清 false:仅 messageEnd(终态,含 abort/失败收尾)。
 *  messageUpdate 绝不清 pending——此前 find-by-id / 末条替换两分支写死 pending:false,
 *  导致流式消息收到第一条 update 后就丢标记,渲染层被迫用全局 streaming 广播兜底,
 *  所有历史 assistant 消息在流式期间被误挂光标(根因修复,勿回退)。 */
function applyEvent(messages: NeutralMessage[], event: SessionEvent): NeutralMessage[] {
  const msg = (event as { message?: NeutralMessage }).message;
  if (event.type === "messageUpdate" && msg) {
    if (msg.id) {
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) return messages.map((m, i) => i === idx ? { ...m, ...msg, pending: true } : m);
    }
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") return [...messages.slice(0, -1), { ...msg, pending: true }];
    return [...messages, { ...msg, pending: true }];
  }
  if (event.type === "messageStart" && msg) {
    if (msg.role === "user") {
      const text = textOf(msg.content);
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user" && messages[i].__optimistic === true && textOf(messages[i].content) === text) {
          return messages.map((m, idx) => idx === i ? { ...msg, pending: true, __optimistic: true } : m);
        }
      }
    }
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && (last.pending || last.content === "" || last.content === undefined)) {
      return [...messages.slice(0, -1), { ...msg, pending: true }];
    }
    return [...messages, { ...msg, pending: true }];
  }
  if (event.type === "messageEnd" && msg) {
    if (msg.id) {
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) return messages.map((m, i) => i === idx ? { ...msg, pending: false, stopped: false } : m);
    }
    const last = messages[messages.length - 1];
    if (last && last.role === msg.role) return [...messages.slice(0, -1), { ...msg, pending: false }];
    if (msg.role === "user") {
      const text = textOf(msg.content);
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user" && messages[i].__optimistic === true && textOf(messages[i].content) === text) {
          return messages.map((m, idx) => idx === i ? msg : m);
        }
      }
    }
    return [...messages, msg];
  }
  if (event.type === "entryAppended") {
    const entry = (event as { entry?: unknown }).entry;
    if (!entry) return messages;
    const neutral = sessionEntryToNeutral(entry);
    if (!neutral) return messages;
    if ((entry as { type?: string }).type === "message") {
      // 消息条目落盘回执:消息体已由 messageStart/Update/End 渲染(底座 AgentMessage 无 id 字段),
      // 这里只做 id 水合——把权威 entryId 补到已渲染消息上(书签/fork/patch 的锚点)。
      // 事件序保证 message_end → entry_appended,倒序取最近一条同 role 同文本且无正式 id 的。
      if (!neutral.id) return messages;
      const text = textOf(neutral.content);
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === neutral.role && textOf(m.content) === text && (m.id == null || m.__optimistic === true)) {
          return messages.map((x, idx) => (idx === i ? { ...x, id: neutral.id } : x));
        }
      }
      return messages;
    }
    // 非消息条目(分隔线/custom 消息):同 role 同文本去重后追加(防底座重复推送)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === neutral.role && textOf(messages[i].content) === textOf(neutral.content)) {
        return messages;
      }
    }
    return [...messages, neutral];
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
      const detail = (await window.pi.sessions.openSession(sessionPath)) as SessionDetail | null;
      // 文件缺失/损坏时显性报错,而不是静默进空会话(cwd 落空导致后续 prompt 抛"未选择工作目录")(评估 M-5)
      if (!detail) throw new Error(`会话文件不可读: ${sessionPath}`);
      // 文件读即基线(秒开);同时记录发送上下文(cwd 取文件 header 的,最准)
      await window.pi.sessions.setContext(detail.info.cwd, sessionPath);
      set({
        messages: detail.messages,
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
    set((s) => ({ messages: [...s.messages, { id: crypto.randomUUID(), role: "user", content: text, __optimistic: true }] }));
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

  // session:event 只含激活会话(main dispatch 已按 activeProcKey 过滤),
  // 后台会话的定稿/轮结束/新文件事件不会进这里——不必再担心视图被别的会话污染。
  window.pi.sessions.onEvent((eventRaw) => {
    const event = eventRaw as SessionEvent;
    if (event.type === "sessionStart") {
      const sf = event.sessionFile;
      if (typeof sf === "string" && sf) {
        useUiStore.getState().setCurrentSessionPath(sf);
      }
    }
    if (event.type === "compactionEnd") {
      void window.pi.sessions.sync();
    }
    useSessionStore.setState((s) => {
      const patched = s.snapshot ? patchStateFromEvent(s.snapshot.state, event) : null;
      const streaming =
        event.type === "agentStart" ? true
        : event.type === "agentSettled" || event.type === "agentEnd" ? false
        : s.streaming;
      return {
        messages: applyEvent(s.messages, event),
        streaming,
        snapshot: patched ? { ...s.snapshot!, state: patched } : s.snapshot,
      };
    });
  });
}
