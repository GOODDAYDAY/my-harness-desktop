// 消息列表(对话区) —— 纯投影渲染:数据全来自 session-store,本组件零拉取零订阅。
//
// 快的三层:
// - 切换:store.switching → 骨架淡出(乐观 UI),快照推送到达即换
// - 长会话:react-virtuoso 虚拟滚动,只渲染可视区(markdown/hljs 不再全量跑)
// - 发送:乐观回显(立即上屏,messageEnd(user) 到了去重)+ 流式由 store 应用
import { useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { Check, Copy } from "lucide-react";
import { usePiApi, useUiStore, useSessionStore, type NeutralMessage } from "@pi-desktop/react";
import { Composer } from "../ui/composer";
import { Markdown } from "../ui/markdown";

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

function toolNamesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "toolCall")
    .map((c) => String((c as Record<string, unknown>).name ?? "tool"));
}

export function MessageList(): React.ReactNode {
  const pi = usePiApi();
  const { currentCwd } = useUiStore();
  const { messages, streaming, switching, ready } = useSessionStore();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      useSessionStore.getState().appendOptimisticUser(text);
      setInput("");
      await pi.sessions.prompt(text);
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

  // 无 cwd 或空会话:hero 居中 + Composer 中置
  if (!currentCwd || (ready && !switching && messages.length === 0)) {
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
    <div className="flex-1 flex flex-col min-h-0 relative">
      {!ready ? (
        <div className="flex-1 flex items-center justify-center text-[var(--color-muted)] text-[length:var(--font-size-base)]">
          正在连接 pi 底座…
        </div>
      ) : (
        <Virtuoso
          data={messages}
          initialTopMostItemIndex={Math.max(0, messages.length - 1)}
          followOutput="smooth"
          alignToBottom
          className="scrollbar-hidden"
          itemContent={(index, m) => (
            <div className="max-w-3xl mx-auto px-4 w-full">
              <div className={index === 0 ? "pt-8 pb-3" : "py-3"}>
                <MessageRow message={m} />
              </div>
            </div>
          )}
          components={{
            Footer: () => (
              <div className="max-w-3xl mx-auto px-4 w-full pb-8">
                {streaming && (
                  <div className="flex items-center gap-2 text-[var(--color-muted)] text-[length:var(--font-size-sm)]">
                    <span className="inline-block size-2 rounded-full bg-[var(--color-muted)] animate-pulse" />
                    agent 思考中…
                  </div>
                )}
              </div>
            ),
          }}
        />
      )}

      {/* 切换会话:旧内容淡出 + 骨架(乐观 UI,快照到达即撤) */}
      {switching && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg)]/70 backdrop-blur-[1px]">
          <div className="size-5 rounded-full border-2 border-[var(--color-muted)] border-t-transparent animate-spin" />
          <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">切换会话…</div>
        </div>
      )}

      <div className="max-w-3xl mx-auto w-full px-4 pb-5">
        {composer}
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: NeutralMessage }): React.ReactNode {
  const text = textOf(message.content);

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
    const tools = toolNamesOf(message.content);
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
