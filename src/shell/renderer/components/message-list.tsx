// 消息列表(对话区) —— 纯投影渲染:数据全来自 session-store,本组件零拉取零订阅。
//
// 快的三层:
// - 切换:store.switching → 骨架淡出(乐观 UI),快照推送到达即换
// - 长会话:react-virtuoso 虚拟滚动,只渲染可视区(markdown/hljs 不再全量跑)
// - 发送:乐观回显(立即上屏,messageEnd(user) 到了去重)+ 流式由 store 应用
import { useState, useEffect, useRef, memo } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { Check, Copy, Cpu, Brain, Archive, GitBranch, Pencil, ChevronDown, ChevronRight, Terminal, Bookmark, FileQuestion, FileText, Edit3, Zap, ArrowRight, Diamond } from "lucide-react";
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

/** 思考强度默认枚举(pi 没起时用,起了 pi 用底座返回的覆盖)。 */
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

function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "thinking")
    .map((c) => String((c as Record<string, unknown>).thinking ?? (c as Record<string, unknown>).text ?? ""))
    .join("\n");
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

export function MessageList(): React.ReactNode {
  const pi = usePiApi();
  const { t } = useTranslation();
  const { currentCwd, currentModelId, currentThinkingLevel, setCurrentModelId, setCurrentThinkingLevel, mainView } = useUiStore();
  const { snapshot, messages, streaming, switching } = useSessionStore();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // 智能滚动:用户上滑停跟尾 + 回到底按钮(L1.5 §4.5.4)
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // 模型清单:从 models.json 拉(不要 pi 进程),启动就拉,不依赖 snapshot。
  // 思考强度清单:pi 起着用底座的;没起用内置 DEFAULT_LEVELS(始终有可选)。
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [levels, setLevels] = useState<string[]>(DEFAULT_LEVELS);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const refreshStats = (): void => { void pi.sessions.getStats().then((s) => setStats(s as SessionStats)).catch(() => {}); };

  // 启动拉模型清单(models.json,不要 pi)。思考强度清单用内置 DEFAULT_LEVELS,不依赖 pi 进程。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await pi.models.get<ModelsConfig>();
        if (cancelled) return;
        setModels(toModelInfos(cfg));
      } catch { /* models.json 读失败:清单留空 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi]);

  // pi 起来(snapshot 有值)后:拉统计。
  // 草稿态:不在此自动下发 set_model——用户"只有发送才生效",pi 起来用底座默认 state,
  // 第一次发送时 send flush 草稿覆盖。冷启动窗口期无 prompt 即不跑模型,安全。
  useEffect(() => {
    if (!snapshot) return;
    refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi, snapshot]);

  // 事件流刷新统计
  useEffect(() => {
    const off = pi.sessions.onEvent((event) => {
      if (event.type === "messageEnd" || event.type === "agentSettled" || event.type === "agentEnd") refreshStats();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi]);

  // 最近一条会话的模型/思考设置(没起 pi + 没偏好时的默认值兜底,从会话文件反推)
  const [recent, setRecent] = useState<{ provider?: string; modelId?: string; thinkingLevel?: string }>({});
  useEffect(() => {
    if (!currentCwd) { setRecent({}); return; }
    void pi.sessions.recentSettings(currentCwd).then(setRecent).catch(() => setRecent({}));
  }, [pi, currentCwd]);

  const [generalConfig, setGeneralConfig] = useState<Record<string, unknown>>({});
  useEffect(() => {
    void window.pi.configFile.get("~/.pi-desktop/config/general.json").then(setGeneralConfig).catch(() => setGeneralConfig({}));
  }, [mainView]);

  // 当前模型/级别 fallback 链:
  // 草稿(用户显式选择) → config default(通用配置) → snapshot(pi 运行态) → recent → 硬编码。
  // config default 在 snapshot 之前:配置是用户意图,snapshot 是底座旧态(可能已过时)。
  // 发送时 send flush 用同一优先级:prefLevel = draft ?? configDefault ?? "high"。
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

  // 选模型/思考强度:只改草稿(ui-store 偏好),不发 RPC。
  // 发送时 send flush 对比草稿 vs snapshot,不一致才下发 set_model/set_thinking_level。
  // 聊天中随意改,生效在下次空闲发送时(send=底座空闲,flush 不被忽略)。
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
    try {
      // flush 草稿:对比草稿(ui-store 偏好)与底座生效值(snapshot.state),
      // 不一致先 await set_model/set_thinking_level 再 prompt,保证本次发送按草稿跑。
      const ui = useUiStore.getState();
      const store = useSessionStore.getState();
      const snap = store.snapshot?.state;
      // flush 模型
      const prefModel = ui.currentModelId;
      const snapModel = snap?.model ? `${snap.model.provider}/${snap.model.id}` : null;
      if (prefModel && prefModel !== snapModel) {
        const [provider, modelId] = prefModel.split("/");
        if (provider && modelId) await pi.sessions.setModel(provider, modelId).catch(() => {});
      }
      // flush thinking
      const prefLevel = ui.currentThinkingLevel ?? String(generalConfig["defaultThinkingLevel"] ?? "high");
      const snapLevel = snap?.thinkingLevel ?? null;
      if (prefLevel !== snapLevel) {
        await pi.sessions.setThinkingLevel(prefLevel).catch(() => {});
      }
      // 工具过滤软过滤（过渡期）：读会话 header 的 toolConfig，
      // mode=custom 时在消息前拼系统指令限制 LLM 可用工具。
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
                finalText = `[System] 本次会话已限制可用工具。\n可用工具: ${[...enabledTools].join(", ")}\n请勿使用未在列表中的工具。\n\n${text}`;
              }
            }
          }
        } catch { /* 过渡期软过滤:读 header 失败则不过滤,不阻塞发送 */ }
      }
      // 同时加 user 消息 + assistant 占位(pending:true),消除空窗(L1.5 §4.5.1)
      store.appendOptimisticUser(text);
      store.appendPendingAssistant();
      setInput("");
      await pi.sessions.prompt(finalText);
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
      onPickModel={pickModel}
      onPickLevel={pickLevel}
    />
  );

  // 空态:hero 居中 + composer 始终钉底(L1.5 §4.5.3:不跳变,和有消息态共享布局)
  if (!currentCwd || (!switching && messages.length === 0)) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
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
        {/* composer 始终钉底;左右比消息区更宽,视觉更聚焦 */}
        <div className="w-full px-8 md:px-16 lg:px-24 pb-5 shrink-0">{composer}</div>
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
        atBottomStateChange={(atBottom) => setIsAtBottom(atBottom)}
        computeItemKey={(_, m) => m.id ?? String(_)}
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
                  {t("shell.thinking")}
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
          <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("shell.switchingSession")}</div>
        </div>
      )}

      <div className="relative w-full px-8 md:px-16 lg:px-24 pb-5 shrink-0">
        {!isAtBottom && messages.length > 0 && (
          <button
            onClick={() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: "smooth" })}
            className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] text-[var(--color-fg)] border border-[var(--color-border)]"
            style={{ background: "var(--color-surface)", boxShadow: "var(--shadow-md)" }}
          >
            <ChevronDown className="size-3.5" />
            {t("shell.scrollToBottom")}
          </button>
        )}
        {composer}
      </div>
    </div>
  );
}

// memo:流式中未变消息不重渲(props 只有 message,浅比较按引用阻断)
const MessageRow = memo(function MessageRow({ message }: { message: NeutralMessage }): React.ReactNode {
  const { t } = useTranslation();
  const { currentSessionPath, requestBookmark } = useUiStore();
  const text = textOf(message.content);

  const handleContextMenu = (e: React.MouseEvent): void => {
    if (!currentSessionPath || !message.id || message.role === "divider") return;
    e.preventDefault();
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 30) || "(空消息)";
    requestBookmark({ sessionPath: currentSessionPath, entryId: message.id, preview });
  };

  // 分隔层:model_change/thinking_level_change/compaction/branch_summary/session_info
  if (message.role === "divider") {
    return <EntryDivider kind={String(message.kind ?? "info")} text={text} detail={message.detail as string | undefined} />;
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
    const thinking = thinkingOf(message.content);
    return (
      <div className="group relative" onContextMenu={handleContextMenu}>
        {thinking && <ThinkingBlock text={thinking} />}
        {tools.map((tc, i) => <ToolExecBar key={tc.id ?? i} toolCall={tc} />)}
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
      <ToolExecBar
        toolCall={{
          name: "bash",
          args: { command: cmd, cwd: message.cwd },
          result: output,
          isError: exitCode !== null && exitCode !== 0,
        }}
      />
    );
  }

  return <ToolExecBar toolCall={{ name: String(message.name ?? message.role), args: message, result: message.content }} />;
});

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

function ToolExecIcon({ name }: { name: string }): React.ReactNode {
  const map: Record<string, React.ReactNode> = {
    bash: <Terminal className="size-3.5" />,
    read_file: <FileText className="size-3.5" />,
    edit_file: <Edit3 className="size-3.5" />,
    write_file: <Edit3 className="size-3.5" />,
    run_tests: <Zap className="size-3.5" />,
    toolResult: <ArrowRight className="size-3.5" />,
    custom_message: <Diamond className="size-3.5" />,
  };
  return map[name] ?? <Terminal className="size-3.5" />;
}

function fmtResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

function fmtArgs(args: unknown): [string, string][] {
  if (args == null) return [];
  if (typeof args === "string") return [["input", args]];
  if (typeof args === "object") {
    const obj = args as Record<string, unknown>;
    return Object.entries(obj).map(([k, v]) => [k, typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })()]);
  }
  return [["args", String(args)]];
}

function ToolExecBar({ toolCall }: { toolCall: ToolCallItem }): React.ReactNode {
  const [open, setOpen] = useState(false);
  const isError = toolCall.isError;
  const borderColor = isError
    ? "var(--color-accent-error)"
    : toolCall.name === "toolResult" ? "var(--color-accent)"
    : toolCall.name === "custom_message" ? "var(--color-mauve, var(--color-accent))"
    : "var(--color-accent-success, var(--color-accent))";
  const args = fmtArgs(toolCall.args);
  const resultText = fmtResult(toolCall.result);
  const hasDetail = args.length > 0 || resultText.length > 0;
  const statusText = isError ? "error" : toolCall.state === "pending" ? "running" : resultText ? "done" : "";

  return (
    <div
      className="mb-1.5 rounded-[var(--radius-md)] cursor-pointer transition-colors"
      style={{
        borderLeft: `3px solid ${borderColor}`,
        background: "color-mix(in srgb, var(--color-surface) 30%, transparent)",
        padding: "5px 12px",
      }}
      onClick={() => hasDetail && setOpen(!open)}
    >
      <div className="flex items-center gap-2 text-[length:var(--font-size-sm)] font-[var(--font-family-mono)]">
        <span className="text-[var(--color-muted)]"><ToolExecIcon name={toolCall.name} /></span>
        <span className="text-[var(--color-fg)] flex-1 truncate">{toolCall.name}</span>
        {statusText && (
          <span className="text-xs" style={{ color: isError ? "var(--color-accent-error)" : "var(--color-muted)" }}>{statusText}</span>
        )}
        {hasDetail && (open ? <ChevronDown className="size-3 text-[var(--color-muted)]" /> : <ChevronRight className="size-3 text-[var(--color-muted)]" />)}
      </div>
      {open && hasDetail && (
        <div className="mt-1 pt-1 border-t border-[var(--color-border)] text-xs font-[var(--font-family-mono)] max-h-[400px] overflow-y-auto">
          {args.length > 0 && (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)] opacity-60 mb-0.5">参数</div>
              {args.map(([k, v]) => (
                <div key={k} className="flex gap-1.5 leading-6">
                  <span className="text-[var(--color-accent)] min-w-[50px]">{k}</span>
                  <span className="text-[var(--color-fg)] break-all">{v}</span>
                </div>
              ))}
            </>
          )}
          {resultText && (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)] opacity-60 mb-0.5 mt-1.5">结果</div>
              <pre className="text-[var(--color-muted)] whitespace-pre-wrap leading-5 bg-[var(--color-bg)] rounded-[var(--radius-sm)] px-2.5 py-1.5 mt-0.5">{resultText}</pre>
            </>
          )}
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
