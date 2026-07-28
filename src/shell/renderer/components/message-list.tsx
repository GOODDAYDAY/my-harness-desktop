// 消息列表(对话区) —— 纯投影渲染:数据全来自 session-store,本组件零拉取零订阅。
//
// 快的三层:
// - 切换:store.switching → 骨架淡出(乐观 UI),快照推送到达即换
// - 长会话:react-virtuoso 虚拟滚动,只渲染可视区(markdown/hljs 不再全量跑)
// - 发送:乐观回显(立即上屏,messageEnd(user) 到了去重)+ 流式由 store 应用
import { useState, useEffect } from "react";
import { Virtuoso } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { Check, Copy, Cpu, Brain, Archive, GitBranch, Pencil, ChevronDown, ChevronRight, Terminal, Bookmark, FileQuestion } from "lucide-react";
import { usePiApi, useUiStore, useSessionStore, type NeutralMessage, type ModelInfo, type SessionStats, type ModelsConfig } from "@pi-desktop/react";
import { Composer } from "../ui/composer";
import { Markdown } from "../ui/markdown";

/** ModelsConfig(models.json 已配置) → ModelInfo[](给 composer 下拉)。
 *  只显示用户在 pi-model-manager 配的 provider/model,不含底座预置假模型。 */
function toModelInfos(cfg: ModelsConfig | null | undefined): ModelInfo[] {
  if (!cfg?.providers) return [];
  const out: ModelInfo[] = [];
  for (const [provider, pc] of Object.entries(cfg.providers)) {
    for (const m of pc.models ?? []) {
      out.push({
        provider, id: m.id, name: m.name ?? m.id,
        reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
      });
    }
  }
  return out;
}

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

function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "thinking")
    .map((c) => String((c as Record<string, unknown>).thinking ?? (c as Record<string, unknown>).text ?? ""))
    .join("\n");
}

export function MessageList(): React.ReactNode {
  const pi = usePiApi();
  const { t } = useTranslation();
  const { currentCwd } = useUiStore();
  const { snapshot, messages, streaming, switching } = useSessionStore();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // 模型/思考强度清单 + 统计(pi 就绪后拉一次 + 事件流刷新统计)
  // 模型清单只取 models.json 已配置的(pi.models.get),不用 get_available_models
  // (后者混入底座预置假模型如 claude;只用用户在 pi-model-manager 配的真实 provider/model)。
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [levels, setLevels] = useState<string[]>([]);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const refreshStats = (): void => { void pi.sessions.getStats().then((s) => setStats(s as SessionStats)).catch(() => {}); };
  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    (async () => {
      try {
        const [cfg, ls] = await Promise.all([pi.models.get<ModelsConfig>(), pi.sessions.getThinkingLevels()]);
        if (cancelled) return;
        setModels(toModelInfos(cfg));
        setLevels(ls);
        refreshStats();
      } catch { /* pi 未就绪 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi, snapshot]);
  useEffect(() => {
    const off = pi.sessions.onEvent((event) => {
      if (event.type === "messageEnd" || event.type === "agentSettled" || event.type === "agentEnd") refreshStats();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi]);
  const currentModel = snapshot?.state.model ?? null;
  const currentLevel = snapshot?.state.thinkingLevel ?? "";

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
      models={models}
      levels={levels}
      currentModel={currentModel}
      currentLevel={currentLevel}
      stats={stats}
      onPickModel={(m) => void pi.sessions.setModel(m.provider, m.id).catch(() => {})}
      onPickLevel={(l) => void pi.sessions.setThinkingLevel(l).catch(() => {})}
    />
  );

  // 无 cwd 或空消息:hero 居中 + Composer 中置(pi 不预启,就绪态不构成分支)
  if (!currentCwd || (!switching && messages.length === 0)) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-8 pb-16">
        <div className="text-center">
          <div className="text-[28px] font-semibold text-[var(--color-fg)] tracking-tight">
            {currentCwd ? t("shell.greeting") : t("shell.newChat")}
          </div>
          {!currentCwd && (
            <div className="mt-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">
              从左栏打开一个文件夹开始
            </div>
          )}
        </div>
        {currentCwd && <div className="w-full px-5 md:px-10 lg:px-16">{composer}</div>}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <Virtuoso
        data={messages}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        followOutput="smooth"
        alignToBottom
        className="scrollbar-hidden"
        itemContent={(index, m) => (
          <div className="w-full px-5 md:px-10 lg:px-16">
            <div className={index === 0 ? "pt-8 pb-3" : "py-3"}>
              <MessageRow message={m} />
            </div>
          </div>
        )}
        components={{
          Footer: () => (
            <div className="w-full px-5 md:px-10 lg:px-16 pb-8">
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

      {/* 切换会话:旧内容淡出 + 骨架(乐观 UI,快照到达即撤) */}
      {switching && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg)]/70 backdrop-blur-[1px]">
          <div className="size-5 rounded-full border-2 border-[var(--color-muted)] border-t-transparent animate-spin" />
          <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">切换会话…</div>
        </div>
      )}

      <div className="w-full px-5 md:px-10 lg:px-16 pb-5">
        {composer}
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: NeutralMessage }): React.ReactNode {
  const { t } = useTranslation();
  const text = textOf(message.content);

  // 分隔层:model_change/thinking_level_change/compaction/branch_summary/session_info
  if (message.role === "divider") {
    return <EntryDivider kind={String(message.kind ?? "info")} text={text} detail={message.detail as string | undefined} />;
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[75%] rounded-[28px] px-5 py-3 text-[length:var(--font-size-base)] leading-7 whitespace-pre-wrap"
          style={{ background: "var(--color-surface)", color: "var(--color-fg)" }}
        >
          {text || t("shell.emptyMessage")}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    const tools = toolNamesOf(message.content);
    const thinking = thinkingOf(message.content);
    return (
      <div className="group relative">
        {thinking && <ThinkingBlock text={thinking} />}
        {tools.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1.5">
            {tools.map((t, i) => (
              <span key={i} className="px-2 py-0.5 rounded-full text-xs text-[var(--color-muted)] border border-[var(--color-border)]">
                {t}
              </span>
            ))}
          </div>
        )}
        {text ? <Markdown text={text} /> : tools.length === 0 && !thinking && <div className="text-[var(--color-muted)]">{t("shell.emptyMessage")}</div>}
        {text && <CopyMessageButton text={text} />}
      </div>
    );
  }

  if (message.role === "bashExecution") {
    const cmd = String(message.command ?? "");
    const output = typeof message.output === "string" ? message.output : text;
    const exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
    return (
      <div
        className="rounded-[var(--radius-lg)] border border-[var(--color-border)] px-4 py-3"
        style={{ background: "color-mix(in srgb, var(--color-bg) 55%, black)" }}
      >
        <div className="flex items-center gap-2 text-[length:var(--font-size-sm)] font-[var(--font-family-mono)]">
          <Terminal className="size-3.5 text-[var(--color-muted)]" />
          <span className="text-[var(--color-fg)]">$ {cmd}</span>
          {exitCode !== null && exitCode !== 0 && (
            <span className="ml-auto text-xs text-[var(--color-accent-error)]">exit {exitCode}</span>
          )}
        </div>
        {output && (
          <div className="mt-1.5 text-[length:var(--font-size-sm)] leading-6 font-[var(--font-family-mono)] text-[var(--color-muted)] whitespace-pre-wrap max-h-64 overflow-y-auto">
            {output}
          </div>
        )}
      </div>
    );
  }

  // custom_message(display=true)/ toolResult 等:场景卡(长内容默认折叠)
  return <CustomCard title={String(message.name ?? message.role)} text={text} />;
}

/** assistant 的 thinking 块:默认折叠(思考过程 ▸)。 */
function ThinkingBlock({ text }: { text: string }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        思考过程
      </button>
      {open && (
        <div className="mt-1 pl-4 border-l-2 border-[var(--color-border)] text-[length:var(--font-size-sm)] leading-6 text-[var(--color-muted)] whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

/** 场景卡:标题 + 内容,>400 字符默认折叠。 */
function CustomCard({ title, text }: { title: string; text: string }): React.ReactNode {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 400;
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-center justify-between text-[length:var(--font-size-sm)] text-[var(--color-muted)] mb-1">
        <span>{title}</span>
        {long && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-0.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer"
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {expanded ? t("shell.collapse") : t("shell.expand")}
          </button>
        )}
      </div>
      {text && (
        <div className={`text-[length:var(--font-size-sm)] leading-6 font-[var(--font-family-mono)] text-[var(--color-muted)] whitespace-pre-wrap ${long && !expanded ? "max-h-24 overflow-hidden" : "max-h-96 overflow-y-auto"}`}>
          {text}
        </div>
      )}
    </div>
  );
}

const DIVIDER_ICONS: Record<string, React.ReactNode> = {
  model: <Cpu className="size-3" />,
  thinking: <Brain className="size-3" />,
  compaction: <Archive className="size-3" />,
  branch: <GitBranch className="size-3" />,
  info: <Pencil className="size-3" />,
  label: <Bookmark className="size-3" />,
  entry: <FileQuestion className="size-3" />,
};

/** 分隔线:居中细线 + 小字,compaction/branch 可展开摘要。 */
function EntryDivider({ kind, text, detail }: { kind: string; text: string; detail?: string }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="select-none">
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-[var(--color-border)]" />
        <button
          onClick={() => detail && setOpen(!open)}
          className={`flex items-center gap-1.5 text-xs text-[var(--color-muted)] bg-transparent border-none p-0 ${detail ? "cursor-pointer hover:text-[var(--color-fg)]" : "cursor-default"}`}
        >
          {DIVIDER_ICONS[kind] ?? DIVIDER_ICONS.info}
          {text}
          {detail && (open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />)}
        </button>
        <div className="flex-1 h-px bg-[var(--color-border)]" />
      </div>
      {open && detail && (
        <div className="mt-2 mx-auto max-w-[85%] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs leading-5 text-[var(--color-muted)] whitespace-pre-wrap">
          {detail}
        </div>
      )}
    </div>
  );
}

function CopyMessageButton({ text }: { text: string }): React.ReactNode {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={t("shell.copy")}
      className="absolute -top-1 right-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? t("shell.copied") : t("shell.copy")}
    </button>
  );
}
