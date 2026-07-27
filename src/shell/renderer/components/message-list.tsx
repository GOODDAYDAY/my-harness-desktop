// 消息列表(对话区) —— 对接会话核心(SessionStore),渲染真实消息 + 工具卡片。
//
// 本轮只做 API 迁移(pi.rpc → pi.sessions)+ 无 cwd 的 hero 引导 + nonce 重 resync;
// 仍是壳内组件,迁 timeline 插件留待 mainView 槽开启后(见 index.tsx 中区注释)。
//
// 流程:
// 1. currentCwd 有值:pi.sessions.getSnapshot() 拿快照 → 渲染 entries
//    (快照拿不到 = pi 未启动 → sessions.start(cwd) 后重拿)
// 2. 事件:pi.sessions.onEvent → entryAppended 追加、agentStart/Settled 更新 streaming
// 3. 发送:pi.sessions.prompt(text) → 清空输入框
// 4. sessionNonce 变(新会话/切会话/切目录)→ 重跑 1
import { useEffect, useState, useRef } from "react";
import { usePiApi, useUiStore } from "@pi-desktop/react";
import { Composer } from "../ui/composer";

interface MessageEntry {
  id: string;
  type: string;
  content?: unknown;
  toolCalls?: unknown[];
  toolCallId?: string;
  timestamp?: number;
}

/** 从 entry 提取文本(content[].text 或 fallback)。 */
function extractText(entry: MessageEntry): string {
  const content = entry.content;
  if (Array.isArray(content)) {
    return content
      .filter((c: unknown) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
      .map((c: unknown) => (c as Record<string, unknown>).text ?? "")
      .join("");
  }
  if (typeof content === "string") return content;
  return "";
}

/** 从 entry 提取 role(user/assistant/toolResult)。 */
function extractRole(entry: MessageEntry): "user" | "assistant" | "tool" {
  if (entry.type === "user" || entry.type === "user_bash") return "user";
  if (entry.type === "assistant") return "assistant";
  return "tool";
}

export function MessageList(): React.ReactNode {
  const pi = usePiApi();
  const { currentCwd, sessionNonce } = useUiStore();
  const [entries, setEntries] = useState<MessageEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // cwd/nonce 变 → 重拿快照(拿不到先 start pi 再拿)
  useEffect(() => {
    if (!currentCwd) {
      setEntries([]);
      setStarted(false);
      return;
    }
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        let snapshot: { entries: MessageEntry[]; state: { isStreaming: boolean } } | null = null;
        try {
          snapshot = (await pi.sessions.getSnapshot()) as typeof snapshot;
        } catch {
          await pi.sessions.start(currentCwd);
          // start 后等一小段让 pi 就绪
          await new Promise((r) => setTimeout(r, 500));
          snapshot = (await pi.sessions.getSnapshot()) as typeof snapshot;
        }
        if (cancelled || !snapshot) return;
        setEntries(snapshot.entries ?? []);
        setStreaming(snapshot.state?.isStreaming ?? false);
        setStarted(true);
        off = pi.sessions.onEvent((eventRaw) => {
          const event = eventRaw as { type: string; entry?: MessageEntry; isStreaming?: boolean };
          if (event.type === "entryAppended" && event.entry) {
            setEntries((prev) => [...prev, event.entry as MessageEntry]);
          } else if (event.type === "agentStart") {
            setStreaming(true);
          } else if (event.type === "agentSettled" || event.type === "agentEnd") {
            setStreaming(false);
          }
        });
      } catch (err) {
        console.error("[sessions] 启动失败:", err);
      }
    })();
    return () => { cancelled = true; off?.(); };
  }, [pi, currentCwd, sessionNonce]);

  // 自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries]);

  // 发送
  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await pi.sessions.prompt(text);
      setInput("");
    } catch (err) {
      console.error("[sessions] 发送失败:", err);
    } finally {
      setSending(false);
    }
  };

  // 无 cwd:hero 引导打开文件夹(左栏"项目"分组是唯一入口)
  if (!currentCwd) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--color-muted)]">
        <div className="text-xl text-[var(--color-fg)]">新对话</div>
        <div className="text-sm">从左栏打开一个文件夹开始</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 scrollbar-hidden">
        {!started && (
          <div className="text-center text-[var(--color-muted)] py-10 text-sm">
            正在连接 pi 底座…
          </div>
        )}
        {started && entries.length === 0 && (
          <div className="text-center text-[var(--color-muted)] py-10 text-sm">
            连接成功。发送一条消息开始对话。
          </div>
        )}
        {entries.map((entry) => (
          <MessageBubble key={entry.id} entry={entry} />
        ))}
        {streaming && (
          <div className="text-center text-[var(--color-muted)] py-2 text-xs">
            agent 思考中…
          </div>
        )}
      </div>

      <div className="pb-3">
        <Composer
          value={input}
          onValueChange={setInput}
          onSubmit={send}
          sending={sending}
        />
      </div>
    </div>
  );
}

function MessageBubble({ entry }: { entry: MessageEntry }): React.ReactNode {
  const role = extractRole(entry);
  const text = extractText(entry);
  const isUser = role === "user";
  const isTool = role === "tool";

  if (isTool) {
    return (
      <div className="my-2 px-3 py-2 rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] font-[var(--font-family-mono)] text-sm text-[var(--color-muted)] whitespace-pre-wrap">
        <div className="font-[var(--font-family-sans)] text-[var(--color-accent-warning)] mb-1 text-xs">
          [tool] {entry.toolCalls?.[0] ? ((entry.toolCalls[0] as Record<string, unknown>).name ?? "tool") : "tool"}
        </div>
        {text || "(无文本输出)"}
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} my-2`}>
      <div
        className={`max-w-[80%] px-3 py-2 rounded-2xl whitespace-pre-wrap text-sm ${
          isUser
            ? "bg-[var(--color-primary)] text-[var(--color-primary-fg)]"
            : "bg-[var(--color-surface)] text-[var(--color-fg)]"
        }`}
      >
        {text || "(空消息)"}
      </div>
    </div>
  );
}
