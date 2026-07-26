// 消息列表(对话区) —— 对接 pi RPC,渲染真实消息 + 工具卡片。
//
// 依据 docs/plugins/08(timeline 插件):消息流来自 pi 的 event 流 + get_entries 历史。
// 当前是 shell/renderer 直接实现(非 timeline 插件),后续提取为 timeline 插件。
//
// 流程:
// 1. 启动:pi.rpc.start() → pi.rpc.resync() 拿 SyncSnapshot → 渲染 entries
// 2. 事件:pi.rpc.onEvent → entryAppended 追加、messageUpdate 更新、toolCallStart/End 渲染工具卡片
// 3. 发送:pi.rpc.send(buildPromptCommand({message})) → 等 success → 清空输入框
import { useEffect, useState, useRef } from "react";
import { usePiApi } from "@pi-desktop/react";
import { Button } from "../ui/button";

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
  const [entries, setEntries] = useState<MessageEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 启动 RPC + resync
  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      try {
        await pi.rpc.start();
        const snapshot = (await pi.rpc.resync()) as { entries: MessageEntry[]; state: { isStreaming: boolean } };
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
    return () => { off?.(); };
  }, [pi]);

  // 自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries]);

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "var(--spacing-lg) var(--spacing-xl)",
      }}
    >
      {!started && (
        <div style={{ textAlign: "center", color: "var(--color-muted)", padding: "var(--spacing-xl)" }}>
          正在连接 pi 底座…
        </div>
      )}
      {started && entries.length === 0 && (
        <div style={{ textAlign: "center", color: "var(--color-muted)", padding: "var(--spacing-xl)" }}>
          连接成功。发送一条消息开始对话。
        </div>
      )}
      {entries.map((entry) => (
        <MessageBubble key={entry.id} entry={entry} />
      ))}
      {streaming && (
        <div style={{ textAlign: "center", color: "var(--color-muted)", fontSize: "var(--font-size-sm)", padding: "var(--spacing-sm)" }}>
          agent 思考中…
        </div>
      )}
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
      <div
        style={{
          margin: "var(--spacing-sm) 0",
          padding: "var(--spacing-sm) var(--spacing-md)",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          fontFamily: "var(--font-family-mono)",
          fontSize: "var(--font-size-sm)",
          color: "var(--color-muted)",
          whiteSpace: "pre-wrap",
        }}
      >
        <div style={{ fontFamily: "var(--font-family-sans)", color: "var(--color-accent.warning)", marginBottom: "var(--spacing-xs)" }}>
          [tool] {entry.toolCalls?.[0] ? ((entry.toolCalls[0] as Record<string, unknown>).name ?? "tool") : "tool"}
        </div>
        {text || "(无文本输出)"}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        margin: "var(--spacing-sm) 0",
      }}
    >
      <div
        style={{
          maxWidth: "80%",
          padding: "var(--spacing-sm) var(--spacing-md)",
          background: isUser ? "var(--color-primary)" : "var(--color-surface)",
          color: isUser ? "var(--color-primary-fg)" : "var(--color-fg)",
          borderRadius: "var(--radius-md)",
          whiteSpace: "pre-wrap",
        }}
      >
        {text || "(空消息)"}
      </div>
    </div>
  );
}

/** 输入框(和消息流一体,贴在对话区底部)。 */
export function Composer(): React.ReactNode {
  const pi = usePiApi();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = async (): Promise<void> => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await pi.rpc.send({ type: "prompt", message: text.trim() });
      setText("");
    } catch (err) {
      console.error("[rpc] 发送失败:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--color-border)",
        padding: "var(--spacing-md) var(--spacing-xl)",
        display: "flex",
        gap: "var(--spacing-sm)",
        alignItems: "flex-end",
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="给 agent 发消息… (Cmd+Enter 发送)"
        style={{
          flex: 1,
          resize: "none",
          minHeight: "var(--spacing-xl)",
          maxHeight: "120px",
          padding: "var(--spacing-sm) var(--spacing-md)",
          background: "var(--color-surface)",
          color: "var(--color-fg)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          fontFamily: "var(--font-family-sans)",
          fontSize: "var(--font-size-base)",
          outline: "none",
        }}
        rows={1}
      />
      <Button variant="primary" onClick={() => void send()} disabled={sending || !text.trim()}>
        {sending ? "发送中…" : "发送"}
      </Button>
    </div>
  );
}
