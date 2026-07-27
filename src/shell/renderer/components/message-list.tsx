// 消息列表(对话区) —— 对接 pi RPC,渲染真实消息 + 工具卡片。
//
// 依据 docs/plugins/08(timeline 插件):消息流来自 pi 的 event 流 + get_entries 历史。
// 当前是 shell/renderer 直接实现(非 timeline 插件),后续提取为 timeline 插件。
//
// 布局激进参考 open-webui:消息流大左右留白中轴(横向 padding 由 index.tsx 的 max-w-6xl 容器控,
// 此处只加纵向 padding);气泡 rounded-2xl;输入区用 pi.ui Composer 软容器(见 ui/composer.tsx)。
//
// 流程:
// 1. 启动:pi.rpc.start() → pi.rpc.resync() 拿 SyncSnapshot → 渲染 entries
// 2. 事件:pi.rpc.onEvent → entryAppended 追加、messageUpdate 更新、toolCallStart/End 渲染工具卡片
// 3. 发送:pi.rpc.send({type:prompt, message}) → 成功 → 清空输入框(send 逻辑在此,经 props 传 Composer)
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
  const { currentCwd } = useUiStore();
  const [entries, setEntries] = useState<MessageEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 启动 RPC + resync(cwd 变时重跑,sidebar 切目录已 stop+start 新 pi)
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        // 等 pi 起来:先试 resync,失败就 start 再 resync
        let snapshot: { entries: MessageEntry[]; state: { isStreaming: boolean } } | null = null;
        try {
          snapshot = (await pi.rpc.resync()) as { entries: MessageEntry[]; state: { isStreaming: boolean } };
        } catch {
          // pi 还没起,start 再 resync
          await pi.rpc.start();
          // start 后等一小段让 pi 就绪
          await new Promise((r) => setTimeout(r, 500));
          snapshot = (await pi.rpc.resync()) as { entries: MessageEntry[]; state: { isStreaming: boolean } };
        }
        if (cancelled) return;
        setEntries(snapshot.entries ?? []);
        setStreaming(snapshot.state?.isStreaming ?? false);
        setStarted(true);
        // 订阅事件
        off = pi.rpc.onEvent((eventRaw) => {
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
        console.error("[rpc] 启动失败:", err);
      }
    })();
    return () => { cancelled = true; off?.(); };
  }, [pi, currentCwd]);

  // 自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries]);

  // 发送(send 逻辑在此,经 props 传 Composer)
  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await pi.rpc.send({ type: "prompt", message: text });
      setInput("");
    } catch (err) {
      console.error("[rpc] 发送失败:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 消息流:纵向 padding,横向留白由 index.tsx 的 max-w-6xl 容器控 */}
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

      {/* 输入区:pi.ui Composer 软容器(底部留白) */}
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

/** 旧的内联 Composer 实现已删除 —— 输入区改用 pi.ui Composer(见 ui/composer.tsx),
 *  由 MessageList 经 props 注入 value/onValueChange/onSubmit。 */
