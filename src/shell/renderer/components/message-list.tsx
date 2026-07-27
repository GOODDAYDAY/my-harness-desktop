// 消息列表(对话区) —— ChatGPT 风格:内容中轴、用户右气泡、助手通栏、空态 hero + Composer 中置。
//
// 数据流程不变:getSnapshot → entries,onEvent → 增量,prompt 发送,nonce/cwd 变重拿。
// 本轮是视觉重构:比例/留白/层级对齐 ChatGPT(16px 正文、leading-7、消息间大间距、
// 空态时 Composer 挪到中轴中央)。
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

/** 可渲染条目:有文本或有工具调用——元数据条目(model_change/thinking_level_change 等)不渲染。 */
function isVisible(entry: MessageEntry): boolean {
  return extractText(entry).trim().length > 0 || (entry.toolCalls?.length ?? 0) > 0;
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries]);

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

  const composer = (
    <Composer value={input} onValueChange={setInput} onSubmit={send} sending={sending} />
  );

  // 元数据条目过滤后再判空:新会话也有 model_change 等条目,不能直接看 entries.length
  const visible = entries.filter(isVisible);

  // 无 cwd 或空会话:hero 居中 + Composer 中置(ChatGPT 新对话形态)
  if (!currentCwd || (started && visible.length === 0)) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-8 pb-16">
        <div className="text-center">
          <div className="text-[28px] font-semibold text-[var(--color-fg)] tracking-tight">
            {currentCwd ? "有什么可以帮你的?" : "新对话"}
          </div>
          {!currentCwd && (
            <div className="mt-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">
              从左栏打开一个文件夹开始
            </div>
          )}
        </div>
        {currentCwd && <div className="w-full max-w-3xl px-4">{composer}</div>}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-hidden">
        <div className="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
          {!started && (
            <div className="text-center text-[var(--color-muted)] py-10 text-[length:var(--font-size-base)]">
              正在连接 pi 底座…
            </div>
          )}
          {visible.map((entry) => (
            <MessageBubble key={entry.id} entry={entry} />
          ))}
          {streaming && (
            <div className="flex items-center gap-2 text-[var(--color-muted)] text-[length:var(--font-size-sm)]">
              <span className="inline-block size-2 rounded-full bg-[var(--color-muted)] animate-pulse" />
              agent 思考中…
            </div>
          )}
        </div>
      </div>
      <div className="max-w-3xl mx-auto w-full px-4 pb-5">
        {composer}
      </div>
    </div>
  );
}

function MessageBubble({ entry }: { entry: MessageEntry }): React.ReactNode {
  const role = extractRole(entry);
  const text = extractText(entry);
  const isUser = role === "user";

  if (role === "tool") {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)] mb-1 font-[var(--font-family-sans)]">
          {entry.toolCalls?.[0] ? String((entry.toolCalls[0] as Record<string, unknown>).name ?? "tool") : "tool"}
        </div>
        <div className="text-[length:var(--font-size-sm)] leading-6 font-[var(--font-family-mono)] text-[var(--color-muted)] whitespace-pre-wrap">
          {text || "(无文本输出)"}
        </div>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[75%] rounded-[28px] px-5 py-3 text-[length:var(--font-size-base)] leading-7 whitespace-pre-wrap"
          style={{ background: "var(--color-surface)", color: "var(--color-fg)" }}
        >
          {text || "(空消息)"}
        </div>
      </div>
    );
  }

  // 助手:通栏无气泡(ChatGPT 形态)
  return (
    <div className="text-[length:var(--font-size-base)] leading-7 text-[var(--color-fg)] whitespace-pre-wrap">
      {text || "(空消息)"}
    </div>
  );
}
