// 消息列表(对话区) —— ChatGPT 风格:内容中轴、用户右气泡、助手 Markdown 通栏、流式输出。
//
// 数据源是 get_messages(NeutralMessage,role+content)——get_entries 给的是会话树
// 条目元数据("message" 条目无 content),别混用(上轮踩过)。
// 流式:messageStart 占位 → messageUpdate 实时刷新末条助手消息 → messageEnd 定稿;
// agentStart/Settled 控 Composer 停止键。nonce/cwd 变重拿快照。
import { useEffect, useState, useRef } from "react";
import { Check, Copy } from "lucide-react";
import { usePiApi, useUiStore, type NeutralMessage, type SyncSnapshot } from "@pi-desktop/react";
import { Composer } from "../ui/composer";
import { Markdown } from "../ui/markdown";

/** 从消息 content 提取纯文本(string 或 [{type:"text"}] 块;thinking/toolCall 块跳过)。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
      .map((c) => String((c as Record<string, unknown>).text ?? ""))
      .join("");
  }
  return "";
}

/** 从 assistant 内容块提取工具调用名列表(渲染小徽章用)。 */
function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "toolCall")
    .map((c) => String((c as Record<string, unknown>).name ?? "tool"));
}

export function MessageList(): React.ReactNode {
  const pi = usePiApi();
  const { currentCwd, sessionNonce } = useUiStore();
  const [messages, setMessages] = useState<NeutralMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentCwd) {
      setMessages([]);
      setStarted(false);
      return;
    }
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        let snapshot: SyncSnapshot | null = null;
        try {
          snapshot = (await pi.sessions.getSnapshot()) as SyncSnapshot;
        } catch {
          await pi.sessions.start(currentCwd);
          await new Promise((r) => setTimeout(r, 500));
          snapshot = (await pi.sessions.getSnapshot()) as SyncSnapshot;
        }
        if (cancelled || !snapshot) return;
        setMessages(snapshot.messages ?? []);
        setStreaming(snapshot.state?.isStreaming ?? false);
        setStarted(true);
        off = pi.sessions.onEvent((eventRaw) => {
          const event = eventRaw as { type: string; message?: NeutralMessage };
          if (event.type === "agentStart") {
            setStreaming(true);
          } else if (event.type === "agentSettled" || event.type === "agentEnd") {
            setStreaming(false);
          } else if (event.type === "messageUpdate" && event.message) {
            // 流式(只 assistant):末条是 assistant 就替换,否则追加
            const msg = event.message;
            if (msg.role !== "assistant") return;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") return [...prev.slice(0, -1), msg];
              return [...prev, msg];
            });
          } else if (event.type === "messageEnd" && event.message) {
            // 定稿:与末条同 role(流式中的 assistant)就替换,否则追加
            const msg = event.message;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === msg.role && msg.role === "assistant") {
                return [...prev.slice(0, -1), msg];
              }
              return [...prev, msg];
            });
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
  }, [messages]);

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
    <Composer
      value={input}
      onValueChange={setInput}
      onSubmit={send}
      sending={sending}
      streaming={streaming}
      onStop={() => void pi.sessions.abort()}
    />
  );

  // 无 cwd 或空会话:hero 居中 + Composer 中置(ChatGPT 新对话形态)
  if (!currentCwd || (started && messages.length === 0)) {
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
          {messages.map((m, i) => (
            <MessageRow key={i} message={m} />
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

function MessageRow({ message }: { message: NeutralMessage }): React.ReactNode {
  const text = extractText(message.content);

  if (message.role === "user") {
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

  if (message.role === "assistant") {
    const tools = extractToolNames(message.content);
    return (
      <div className="group relative">
        {tools.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1.5">
            {tools.map((t, i) => (
              <span key={i} className="px-2 py-0.5 rounded-full text-xs text-[var(--color-muted)] border border-[var(--color-border)]">
                {t}
              </span>
            ))}
          </div>
        )}
        {text ? <Markdown text={text} /> : tools.length === 0 && <div className="text-[var(--color-muted)]">(空消息)</div>}
        {text && <CopyMessageButton text={text} />}
      </div>
    );
  }

  // toolResult / custom_message 等:工具卡片
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)] mb-1">
        {String(message.name ?? message.role)}
      </div>
      {text && (
        <div className="text-[length:var(--font-size-sm)] leading-6 font-[var(--font-family-mono)] text-[var(--color-muted)] whitespace-pre-wrap max-h-64 overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  );
}

/** 消息悬停复制按钮(右上,hover 出现)。 */
function CopyMessageButton({ text }: { text: string }): React.ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title="复制"
      className="absolute -top-1 right-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}
