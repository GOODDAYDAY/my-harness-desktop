import { useState, useEffect, useRef, memo } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { Check, Copy, Cpu, Brain, Archive, GitBranch, Pencil, ChevronDown, ChevronRight, Bookmark, FileQuestion } from "lucide-react";
import { usePiApi, useUiStore, useSessionStore, registerMainViewComponent, type NeutralMessage, type ModelInfo, type SessionStats, type ModelsConfig } from "@pi-desktop/react";
import { Composer } from "./composer";
import { Markdown } from "./markdown";
import { ToolCardRenderer } from "./tool-cards";
import { ThinkingChainBlock, type ThinkingContent } from "./thinking-chain-block";
import { JumpToBottomButton, useScrollBridge } from "./timeline-scroll-bridge";

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

const DEFAULT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

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

function thinkingBlocksOf(content: unknown): ThinkingContent[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "thinking")
    .map((c) => {
      const item = c as Record<string, unknown>;
      return {
        type: "thinking" as const,
        thinking: String(item.thinking ?? item.text ?? ""),
        redacted: item.redacted === true,
        thinkingSignature: typeof item.thinkingSignature === "string" ? item.thinkingSignature : undefined,
      };
    });
}

type ToolCallItem = {
  id?: string;
  name: string;
  args?: unknown;
  state?: string;
  result?: unknown;
  isError?: boolean;
};

function toolCallsOf(content: unknown): ToolCallItem[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "toolCall")
    .map((c) => {
      const item = c as Record<string, unknown>;
      return {
        id: typeof item.id === "string" ? item.id : undefined,
        name: String(item.name ?? "tool"),
        args: item.args,
        state: typeof item.state === "string" ? item.state : undefined,
        result: item.result,
        isError: item.isError === true,
      };
    });
}

function TimelineView(): React.ReactNode {
  const pi = usePiApi();
  const { t } = useTranslation();
  const { currentCwd, currentModelId, currentThinkingLevel, setCurrentModelId, setCurrentThinkingLevel, activeView } = useUiStore();
  const { snapshot, messages, streaming, switching } = useSessionStore();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const scrollBridge = useScrollBridge();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [levels, setLevels] = useState<string[]>(DEFAULT_LEVELS);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const refreshStats = (): void => { void pi.sessions.getStats().then((s) => setStats(s as SessionStats)).catch(() => {}); };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await pi.models.get<ModelsConfig>();
        if (cancelled) return;
        setModels(toModelInfos(cfg));
      } catch { }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi]);

  useEffect(() => {
    if (!snapshot) return;
    refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi, snapshot]);

  useEffect(() => {
    const off = pi.sessions.onEvent((event) => {
      if (event.type === "messageEnd" || event.type === "agentSettled" || event.type === "agentEnd") refreshStats();
      if (event.type === "messageStart" || event.type === "messageUpdate") scrollBridge.onNewItem();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi]);

  const [recent, setRecent] = useState<{ provider?: string; modelId?: string; thinkingLevel?: string }>({});
  useEffect(() => {
    if (!currentCwd) { setRecent({}); return; }
    void pi.sessions.recentSettings(currentCwd).then(setRecent).catch(() => setRecent({}));
  }, [pi, currentCwd]);

  const [generalConfig, setGeneralConfig] = useState<Record<string, unknown>>({});
  useEffect(() => {
    void window.pi.configFile.get("~/.pi-desktop/config/general.json").then(setGeneralConfig).catch(() => setGeneralConfig({}));
  }, [activeView]);

  const currentModel =
    models.find((m) => `${m.provider}/${m.id}` === currentModelId)
    ?? snapshot?.state.model
    ?? (recent.provider && recent.modelId ? models.find((m) => m.provider === recent.provider && m.id === recent.modelId) : null)
    ?? models[0]
    ?? null;
  const configDefault = generalConfig["defaultThinkingLevel"];
  const configDefaultStr = typeof configDefault === "string" && configDefault ? configDefault : null;
  const currentLevel =
    currentThinkingLevel
    ?? configDefaultStr
    ?? snapshot?.state.thinkingLevel
    ?? recent.thinkingLevel
    ?? "high";

  const pickModel = (m: ModelInfo): void => {
    setCurrentModelId(`${m.provider}/${m.id}`);
  };
  const pickLevel = (l: string): void => {
    setCurrentThinkingLevel(l);
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || sending || !currentCwd) return;
    setSending(true);
    setIsAtBottom(true);
    scrollBridge.scrollToBottom();
    try {
      const ui = useUiStore.getState();
      const store = useSessionStore.getState();
      const snap = store.snapshot?.state;
      const prefModel = ui.currentModelId;
      const snapModel = snap?.model ? `${snap.model.provider}/${snap.model.id}` : null;
      if (prefModel && prefModel !== snapModel) {
        const [provider, modelId] = prefModel.split("/");
        if (provider && modelId) await pi.sessions.setModel(provider, modelId).catch(() => {});
      }
      const prefLevel = ui.currentThinkingLevel ?? String(generalConfig["defaultThinkingLevel"] ?? "high");
      const snapLevel = snap?.thinkingLevel ?? null;
      if (prefLevel !== snapLevel) {
        await pi.sessions.setThinkingLevel(prefLevel).catch(() => {});
      }
      let finalText = text;
      const sessionPath = ui.currentSessionPath;
      if (sessionPath) {
        try {
          const toolCfg = await pi.sessions.readToolConfig(sessionPath);
          if (toolCfg?.mode === "custom" && toolCfg.enabledGroupIds) {
            const cwd = ui.currentCwd;
            if (cwd) {
              const groupsData = await pi.configFile.get(`${cwd}/.pi-desktop/config/tool-groups.json`);
              const groups = (groupsData?.groups as { id: string; toolIds: string[] }[]) ?? [];
              const enabledTools = new Set<string>();
              for (const g of groups) {
                if (toolCfg.enabledGroupIds.includes(g.id)) {
                  for (const id of g.toolIds) enabledTools.add(id);
                }
              }
              if (toolCfg.enabledGroupIds.includes("__default__")) {
                const assigned = new Set<string>();
                for (const g of groups) for (const id of g.toolIds) assigned.add(id);
              }
              if (enabledTools.size > 0) {
                finalText = `[System] \u672c\u6b21\u4f1a\u8bdd\u5df2\u9650\u5236\u53ef\u7528\u5de5\u5177\u3002\n\u53ef\u7528\u5de5\u5177: ${[...enabledTools].join(", ")}\n\u8bf7\u52ff\u4f7f\u7528\u672a\u5728\u5217\u8868\u4e2d\u7684\u5de5\u5177\u3002\n\n${text}`;
              }
            }
          }
        } catch { }
      }
      store.appendOptimisticUser(text);
      store.appendPendingAssistant();
      setInput("");
      await pi.sessions.prompt(finalText);
    } catch (err) {
      console.error("[sessions] \u53d1\u9001\u5931\u8d25:", err);
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
      onPickModel={pickModel}
      onPickLevel={pickLevel}
    />
  );

  if (!currentCwd || (!switching && messages.length === 0)) {
    return (
      <div className="flex-1 flex flex-col min-h-0 relative">
        <div className="flex-1 flex flex-col items-center justify-center">
          {currentCwd ? (
            <div className="text-[28px] font-semibold text-[var(--color-fg)] tracking-tight">
              {t("shell.greeting")}
            </div>
          ) : (
            <div className="text-center">
              <div className="text-[28px] font-semibold text-[var(--color-fg)] tracking-tight">{t("shell.newChat")}</div>
              <div className="mt-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">
                {t("shell.openFolderFirst")}
              </div>
            </div>
          )}
        </div>
        <ComposerDock>{composer}</ComposerDock>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        followOutput={isAtBottom ? "smooth" : undefined}
        alignToBottom
        atBottomStateChange={(atBottom) => {
          setIsAtBottom(atBottom);
          if (atBottom) scrollBridge.scrollToBottom();
        }}
        computeItemKey={(_, m) => m.id ?? String(_)}
        className="scrollbar-hidden"
        itemContent={(index, m) => (
          <div className="w-full max-w-[816px] mx-auto px-5 md:px-8">
            <div className={index === 0 ? "pt-8 pb-3" : "py-3"}>
              <MessageRow message={m} streaming={streaming} />
            </div>
          </div>
        )}
        components={{
          Footer: () => (
            <div className="w-full max-w-[816px] mx-auto px-5 md:px-8 pb-48">
              {streaming && (
                <div className="flex items-center gap-2 text-[var(--color-muted)] text-[length:var(--font-size-sm)]">
                  <span className="inline-block size-2 rounded-full bg-[var(--color-muted)] animate-pulse" />
                  {t("shell.thinking")}
                </div>
              )}
            </div>
          ),
        }}
      />

      {switching && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg)]/70 backdrop-blur-[1px]">
          <div className="size-5 rounded-full border-2 border-[var(--color-muted)] border-t-transparent animate-spin" />
          <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("shell.switchingSession")}</div>
        </div>
      )}

      <ComposerDock>
        {!isAtBottom && messages.length > 0 && (
          <JumpToBottomButton
            unreadCount={scrollBridge.unreadCount}
            onClick={() => {
              virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: "smooth" });
              scrollBridge.scrollToBottom();
            }}
          />
        )}
        {composer}
      </ComposerDock>
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message, streaming }: { message: NeutralMessage; streaming: boolean }): React.ReactNode {
  const { t } = useTranslation();
  const { currentSessionPath, requestBookmark } = useUiStore();
  const text = textOf(message.content);

  const handleContextMenu = (e: React.MouseEvent): void => {
    if (!currentSessionPath || !message.id || message.role === "divider") return;
    e.preventDefault();
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 30) || "(empty)";
    requestBookmark({ sessionPath: currentSessionPath, entryId: message.id, preview });
  };

  if (message.role === "divider") {
    return <EntryDivider
      kind={String(message.kind ?? "info")}
      i18nKey={String(message.i18nKey ?? "timeline.divider")}
      i18nArgs={message.i18nArgs as Record<string, unknown> | undefined}
      detail={message.detail as string | undefined}
    />;
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end" onContextMenu={handleContextMenu}>
        <div
          className="max-w-[65%] rounded-[var(--radius-md)] px-4 py-2.5 text-[length:var(--font-size-base)] leading-7 whitespace-pre-wrap"
          style={{ background: "var(--color-surface)", color: "var(--color-fg)", boxShadow: "0 1px 3px rgba(0,0,0,.12)" }}
        >
          {text || t("shell.emptyMessage")}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    const tools = toolCallsOf(message.content);
    const thinkings = thinkingBlocksOf(message.content);
    const isStreaming = message.pending === true || streaming;
    return (
      <div className="group relative" onContextMenu={handleContextMenu}>
        {thinkings.map((tc, i) => (
          <ThinkingChainBlock
            key={i}
            content={tc}
            streaming={isStreaming}
            startedAt={message.timestamp}
            completedAt={isStreaming ? undefined : message.timestamp}
          />
        ))}
        {tools.map((tc, i) => <ToolCardRenderer key={tc.id ?? i} toolCall={tc} />)}
        {text ? <Markdown text={text} streaming={isStreaming} /> : tools.length === 0 && thinkings.length === 0 && <div className="text-[var(--color-muted)]">{t("shell.emptyMessage")}</div>}
        {message.stopped && (
          <div className="text-[length:var(--font-size-sm)] text-[var(--color-accent-error)] italic mt-1">
            {t("shell.stopped")}
          </div>
        )}
        {message.error && (
          <div className="text-[length:var(--font-size-sm)] text-[var(--color-accent-error)] mt-1">
            {t("shell.error")}
          </div>
        )}
        {text && <CopyMessageButton text={text} />}
      </div>
    );
  }

  if (message.role === "bashExecution") {
    const cmd = String(message.command ?? "");
    const output = typeof message.output === "string" ? message.output : text;
    const exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
    return (
      <ToolCardRenderer
        toolCall={{
          name: "bash",
          args: { command: cmd, cwd: message.cwd },
          result: output,
          isError: exitCode !== null && exitCode !== 0,
        }}
      />
    );
  }

  return <ToolCardRenderer toolCall={{ name: String(message.name ?? message.role), args: message, result: message.content }} />;
});

const DIVIDER_ICONS: Record<string, React.ReactNode> = {
  model: <Cpu className="size-3" />,
  thinking: <Brain className="size-3" />,
  compaction: <Archive className="size-3" />,
  branch: <GitBranch className="size-3" />,
  info: <Pencil className="size-3" />,
  label: <Bookmark className="size-3" />,
  entry: <FileQuestion className="size-3" />,
};

function EntryDivider({ kind, i18nKey, i18nArgs, detail }: {
  kind: string; i18nKey: string; i18nArgs?: Record<string, unknown>; detail?: string;
}): React.ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const text = t(i18nKey, i18nArgs);
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

function ComposerDock({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <div className="absolute bottom-0 left-0 right-0 pointer-events-none">
      <div
        className="h-20"
        style={{ background: "linear-gradient(to bottom, transparent 0%, var(--color-bg) 50%, var(--color-bg) 100%)" }}
      />
      <div className="pointer-events-auto max-w-[768px] mx-auto px-5 md:px-8 pb-4">
        <div className="relative">
          {children}
        </div>
      </div>
    </div>
  );
}

registerMainViewComponent("TimelineView", TimelineView);
