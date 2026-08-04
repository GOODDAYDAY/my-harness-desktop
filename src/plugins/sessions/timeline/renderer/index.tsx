import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { Cpu, Brain, Archive, GitBranch, Pencil, ChevronDown, ChevronRight, Bookmark, FileQuestion, Wrench } from "lucide-react";
import { useUiStore, useSessionStore,  type NeutralMessage, type ModelInfo, type ModelsConfig, type SessionToolConfig, usePluginContext, getMessageRenderer, useComposerPolicies, toolCallsOf, useMessageActions, resolveMessageActionComponent } from "@pi-desktop/react";
import { parseSessionModelPrefs, type SessionInfo } from "@pi-desktop/contract";
import { Composer } from "./composer";
import { Markdown } from "./markdown";
import { ToolCardRenderer } from "./tool-cards";
import { ThinkingChainBlock, type ThinkingContent } from "./thinking-chain-block";
import { UserBubble } from "./user-bubble";
import { JumpToBottomButton, useScrollBridge } from "./timeline-scroll-bridge";

export const channels = ["timeline:bookmarkRequested", "timeline:scrollTo", "timeline:rewindRequested"] as const;

// messageActions 槽动作组件:框架按 manifest component 名在 module exports 自动匹配(§7.4),
// 必须在入口 re-export,否则 resolveMessageActionComponent 拿不到、动作按钮静默不渲。
export { CopyAction, BookmarkAction, RewindAction } from "./message-actions";

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

/** Electron invoke 错误剥壳("Error invoking remote method '…': Error: <原文>")→ 底座原文。 */
function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg);
  return m?.[1] ?? msg;
}

/** 工具限制注入前缀(底座暂无工具白名单 RPC,只能 prompt 注入;演进:待底座提供 RPC 后移除)。
 *  注入文本随用户消息持久化进 JSONL——渲染层用前缀匹配剥掉,不打扰用户气泡。 */
const TOOL_LIMIT_PREFIX = "[System] 本次会话已限制可用工具。";
function buildToolLimitNote(tools: string[]): string {
  return TOOL_LIMIT_PREFIX + "\n可用工具: " + tools.join(", ") + "\n请勿使用未在列表中的工具。";
}
function stripToolLimitNote(text: string): string {
  if (!text.startsWith(TOOL_LIMIT_PREFIX)) return text;
  const sep = text.indexOf("\n\n");
  return sep >= 0 ? text.slice(sep + 2) : "";
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

export function TimelineView(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { currentCwd, currentSessionPath, sessionModelPending, setSessionModelPending, clearSessionModelPending } = useUiStore();
  const { snapshot, messages, streaming, switching, stats, thinkingLevels, syncNonce } = useSessionStore();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // 双击闸门(根因修复):sending 是 useState,同一渲染闭包内双击两次都读到 false,
  // 两个 send() 并发跑——pref flush 各自 ensureForSend 起 pi、setContext 互相把对方
  // 的 activeProcKey 切走,撞出"pi 未启动"。ref 同步可见,第二次点击直接挡掉。
  const sendingRef = useRef(false);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const pendingScrollRef = useRef<{ messageId?: string; position?: "top" | "bottom" } | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // isAtBottomRef 供 effect 同步读取置底意图;state 只能驱动渲染,不能解决闭包时序。
  const isAtBottomRef = useRef(true);
  const setAtBottom = useCallback((v: boolean) => {
    isAtBottomRef.current = v;
    setIsAtBottom(v);
  }, []);
  const scrollBridge = useScrollBridge();

  // 会话切换(openSession: switching true→false)或 resync(sync: syncNonce 递增)时重置滚动位置。
  // 不重置则用户上次滚动上移后 isAtBottom=false,followOutput 不触发,新消息不置底。
  useEffect(() => {
    if (!switching) {
      setAtBottom(true);
      scrollBridge.clearUnread();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switching, syncNonce]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const showToast = (text: string): void => setToast({ key: Date.now(), text });

  const [rewindTarget, setRewindTarget] = useState<{ message: NeutralMessage } | null>(null);
  const [rewindText, setRewindText] = useState("");
  const [rewindSending, setRewindSending] = useState(false);
  const rewindSendingRef = useRef(false);

  const openRewind = useCallback((message: NeutralMessage, text: string): void => {
    if (streaming) { showToast(t("shell.rewindStreamingBlocked")); return; }
    if (!message.id) return;
    if (rewindTarget?.message.id === message.id) { setRewindTarget(null); setRewindText(""); return; }
    setRewindTarget({ message });
    setRewindText(text);
  }, [streaming, t, rewindTarget]);

  useEffect(() => {
    const off = ctx.events.on("timeline:rewindRequested", (payload) => {
      const p = payload as { message: NeutralMessage; text: string } | null;
      if (!p) return;
      openRewind(p.message, p.text);
    });
    return off;
  }, [ctx.events, openRewind]);

  const closeRewind = useCallback((): void => {
    if (rewindSendingRef.current) return;
    setRewindTarget(null);
    setRewindText("");
  }, []);

  useEffect(() => {
    if (!rewindTarget) return;
    const onDown = (e: globalThis.MouseEvent): void => {
      const el = e.target as Element | null;
      if (el?.closest("[data-rewind-inline]")) return;
      closeRewind();
    };
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("mousedown", onDown); };
  }, [rewindTarget, closeRewind]);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const levels = thinkingLevels.length > 0 ? thinkingLevels : DEFAULT_LEVELS;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await ctx.modelsConfig.get<ModelsConfig>();
        if (cancelled) return;
        setModels(toModelInfos(cfg));
      } catch { /* 配置缺失时以空列表兜底,无需提示 */ }
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  // 订阅 notes 插件的"填入输入框"请求:把笔记内容追加进 composer 让用户改后手动发。
  // 追加而非覆盖(用户反馈):已有草稿不能被顶掉,之间空一行衔接多条填入。
  // notes 是可选插件——channel 未加载/已禁用时 on() 会抛错,try/catch 兑底绝不影响 timeline 自身。
  useEffect(() => {
    try {
      return ctx.events.on("notes:fillComposer", (payload) => {
        const text = (payload as { text?: string } | null)?.text;
        if (typeof text === "string" && text) {
          setInput((prev) => {
            const p = prev.trimEnd();
            return p ? `${p}\n\n${text}` : text;
          });
        }
      });
    } catch {
      return undefined;
    }
  }, [ctx.events]);

  useEffect(() => {
    const off = ctx.sessions.onEvent((event) => {
      if ((event.type === "messageStart" || event.type === "messageUpdate") && !isAtBottomRef.current) scrollBridge.notifyUnread();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  useEffect(() => {
    const off = ctx.events.on("timeline:scrollTo", (payload) => {
      const p = payload as { messageId?: string; position?: "top" | "bottom" };
      if (!p.messageId && !p.position) return;
      if (p.position === "top") {
        virtuosoRef.current?.scrollToIndex({ index: 0, behavior: "smooth" });
        return;
      }
      if (p.position === "bottom") {
        virtuosoRef.current?.scrollToIndex({ index: Math.max(0, messages.length - 1), behavior: "smooth" });
        return;
      }
      if (p.messageId) {
        const idx = messages.findIndex(m => m.id === p.messageId);
        if (idx >= 0) {
          virtuosoRef.current?.scrollToIndex({ index: idx, behavior: "smooth" });
        } else {
          pendingScrollRef.current = { messageId: p.messageId };
        }
      }
    });
    return off;
  }, [ctx, messages]);

  useEffect(() => {
    if (pendingScrollRef.current?.messageId) {
      const idx = messages.findIndex(m => m.id === pendingScrollRef.current!.messageId);
      if (idx >= 0) {
        virtuosoRef.current?.scrollToIndex({ index: idx, behavior: "smooth" });
      }
      pendingScrollRef.current = null;
    }
  }, [messages]);

  // 默认配置层的本地镜像(设计 §2.1):只服务新会话壳的显示与 pending 种子,
  // 已活会话的任何路径都不读它。「设为默认」广播只刷新这份镜像,不写任何持久状态。
  const [defaults, setDefaults] = useState<{ provider?: string; modelId?: string }>({});
  useEffect(() => {
    let alive = true;
    void ctx.piSettings.get().then((s) => {
      if (!alive) return;
      setDefaults({
        provider: typeof s.defaultProvider === "string" ? s.defaultProvider : undefined,
        modelId: typeof s.defaultModel === "string" ? s.defaultModel : undefined,
      });
    }).catch(() => {});
    return () => { alive = false; };
  }, [ctx]);
  useEffect(() => {
    const off = ctx.events.on("pi-model-manager:defaultChanged", (payload) => {
      const p = payload as { provider?: string; modelId?: string };
      if (!p.provider || !p.modelId) return;
      setDefaults({ provider: p.provider, modelId: p.modelId });
    });
    return off;
  }, [ctx]);

  // general.json 经 ui-store 单源读(分层合并视图;框架管重读,插件不碰文件通道)
  const generalConfig = useUiStore((s) => s.generalConfig);

  const composerPolicies = useComposerPolicies();
  const [sessionCustom, setSessionCustom] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (!currentCwd || !currentSessionPath) { setSessionCustom(null); return; }
    let alive = true;
    void ctx.sessions.list(currentCwd).then((list) => {
      const found = list.find((s: SessionInfo) => s.path === currentSessionPath);
      if (alive) setSessionCustom(found?.custom ?? null);
    }).catch(() => { if (alive) setSessionCustom(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd, currentSessionPath]);

  // 显示链(设计 §4.2):pending > 快照/头 > 默认。活会话快照是实时真相;
  // 历史会话(进程没起)读头行 model 域;新会话壳读默认配置层。
  const pendingKey = currentSessionPath ?? (currentCwd ? `new:${currentCwd}` : null);
  const pending = pendingKey ? sessionModelPending[pendingKey] : undefined;
  const headerPrefs = parseSessionModelPrefs(sessionCustom ?? undefined);

  const matchedPolicy = sessionCustom && composerPolicies.length > 0
    ? composerPolicies.find((p) => {
        const v = sessionCustom[p.customKey];
        return v !== undefined && v !== null;
      })
    : undefined;

  const collapseDefault = generalConfig["timelineCollapseDefault"] !== false;

  const showHiddenMessages = generalConfig["showHiddenMessages"] === true;
  const visibleMessages = useMemo(
    () => (showHiddenMessages ? messages : messages.filter((m) => m.display !== false)),
    [messages, showHiddenMessages],
  );

  useEffect(() => {
    if (!isAtBottomRef.current || !virtuosoRef.current || visibleMessages.length === 0) return;
    virtuosoRef.current.scrollToIndex({ index: visibleMessages.length - 1, behavior: "auto" });
  }, [visibleMessages]);

  const toModelInfoFallback = (provider: string, modelId: string): ModelInfo =>
    models.find((m) => m.provider === provider && m.id === modelId)
    ?? { provider, id: modelId, name: modelId };
  const currentModel =
    (pending ? toModelInfoFallback(pending.provider, pending.modelId) : null)
    ?? snapshot?.state.model
    ?? (headerPrefs ? toModelInfoFallback(headerPrefs.provider, headerPrefs.modelId) : null)
    ?? (defaults.provider && defaults.modelId ? toModelInfoFallback(defaults.provider, defaults.modelId) : null)
    ?? models[0]
    ?? null;
  const configDefault = generalConfig["defaultThinkingLevel"];
  const configDefaultStr = typeof configDefault === "string" && configDefault ? configDefault : null;
  const currentLevel =
    pending?.thinkingLevel
    ?? snapshot?.state.thinkingLevel
    ?? headerPrefs?.thinkingLevel
    ?? configDefaultStr
    ?? "high";

  // composerApplyTiming: "onSend"(默认)=点选只记内存 pending,send() 时回灌;
  //                      "immediate"=点选即 RPC 到底座(打断生成、分隔线错位,见 design 文档)。
  const composerApplyTiming = String(generalConfig["composerApplyTiming"] ?? "onSend");

  const pickModel = (m: ModelInfo): void => {
    if (composerApplyTiming === "immediate") {
      void (async () => {
        try {
          await ctx.models.setModel(m.provider, m.id);
          await ctx.sessions.sync();
        } catch (err) {
          // 失败显形(设计 §4.1 失败路径):sync 取真值,显示随快照回落。
          showToast(t("timeline.modelApplyFailed", { error: errText(err) }));
          void ctx.sessions.sync().catch(() => {});
        }
      })();
      return;
    }
    // onSend:记内存 pending(整体三字段,深度随当前显示值——意图是"保持深度、换模型")。
    if (pendingKey) {
      setSessionModelPending(pendingKey, { provider: m.provider, modelId: m.id, thinkingLevel: currentLevel });
    }
  };
  const pickLevel = (l: string): void => {
    if (composerApplyTiming === "immediate") {
      void (async () => {
        try {
          await ctx.models.setThinkingLevel(l);
          await ctx.sessions.sync();
        } catch (err) {
          showToast(t("timeline.thinkingApplyFailed", { error: errText(err) }));
          void ctx.sessions.sync().catch(() => {});
        }
      })();
      return;
    }
    // onSend:已有 pending 换档;无 pending 以当前显示模型为种子凑全三字段。
    const provider = pending?.provider ?? currentModel?.provider;
    const modelId = pending?.modelId ?? currentModel?.id;
    if (pendingKey && provider && modelId) {
      setSessionModelPending(pendingKey, { provider, modelId, thinkingLevel: l });
    }
  };

  /** 回灌(设计 §4.3):pending 优先(灌入+清账,意图执行闭环),否则头与快照冷起对齐。
   *  pending 灌入被拒 → 中止发送(pending 保留,意图未执行不丢;用户改值再发即重试)。
   *  头对齐失败 → toast 显形不中止(冷起纠偏失败不该挡住用户在现状模型上发消息)。
   *  返回 true=可继续发送。底座对 model_change/thinking_level_change 只写 JSONL、
   *  不发 entry_appended 事件——任一灌入成功后 sync 一次,让 entries 流(含新 divider)
   *  整体替换 messages;且必须在 sendText 乐观消息之前(否则被 snapshot 冲掉)。 */
  const flushModelPrefs = async (): Promise<boolean> => {
    const snap = useSessionStore.getState().snapshot?.state;
    let needSync = false;
    if (pending && pendingKey) {
      try {
        await ctx.models.setModel(pending.provider, pending.modelId);
        await ctx.models.setThinkingLevel(pending.thinkingLevel);
        clearSessionModelPending(pendingKey);
        needSync = true;
      } catch (err) {
        showToast(t("timeline.modelApplyFailed", { error: errText(err) }));
        return false;
      }
    } else if (headerPrefs) {
      const snapModelId = snap?.model ? `${snap.model.provider}/${snap.model.id}` : null;
      const headerModelId = `${headerPrefs.provider}/${headerPrefs.modelId}`;
      try {
        if (headerModelId !== snapModelId) {
          await ctx.models.setModel(headerPrefs.provider, headerPrefs.modelId);
          needSync = true;
        }
        if (headerPrefs.thinkingLevel !== (snap?.thinkingLevel ?? null)) {
          await ctx.models.setThinkingLevel(headerPrefs.thinkingLevel);
          needSync = true;
        }
      } catch (err) {
        showToast(t("timeline.modelApplyFailed", { error: errText(err) }));
      }
    }
    if (needSync) await ctx.sessions.sync().catch(() => {});
    return true;
  };

  const handleRewindSend = async (): Promise<void> => {
    const text = rewindText.trim();
    if (!text || rewindSendingRef.current || !currentCwd || !rewindTarget?.message.id) return;
    rewindSendingRef.current = true;
    setRewindSending(true);
    try {
      try {
        await ctx.tree.fork(rewindTarget.message.id);
      } catch (err) {
        showToast(t("shell.rewindFailed", { error: errText(err) }));
        return;
      }
      // fork 换绑新会话后统一走同一个回灌点(设计 §4.1:rewind 的独立 flush 拷贝已拆除)
      if (!(await flushModelPrefs())) return;
      const store = useSessionStore.getState();
      await store.sendText(currentCwd, text, text);
      setRewindTarget(null);
      setRewindText("");
      setAtBottom(true);
      scrollBridge.clearUnread();
    } catch (err) {
      showToast(t("shell.rewindFailed", { error: errText(err) }));
      setRewindTarget(null);
      setRewindText("");
    } finally {
      rewindSendingRef.current = false;
      setRewindSending(false);
    }
  };

  const handleRewindStop = (): void => {
    void ctx.messaging.abort();
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || sendingRef.current || !currentCwd) return;
    sendingRef.current = true;
    setSending(true);
    setAtBottom(true);
    scrollBridge.clearUnread();
    try {
      const ui = useUiStore.getState();
      const store = useSessionStore.getState();
      if (!(await flushModelPrefs())) return;
      let finalText = text;
      const sessionPath = ui.currentSessionPath;
      if (sessionPath) {
        try {
          // 工具过滤 onSend flush(tool-manager 组开关只是内存偏好,发送这一刻才落盘,
          // 与上面模型/强度的 diff-flush 同语义)。flushed 的偏好跳过——不重复写不重复 toast。
          const pendingTools = ui.pendingToolConfig?.sessionPath === sessionPath ? ui.pendingToolConfig : null;
          let toolCfg: SessionToolConfig | null;
          if (pendingTools && !pendingTools.flushed) {
            await ctx.sessions.updateHeader(sessionPath, { toolConfig: pendingTools.config });
            ui.setPendingToolConfig({ ...pendingTools, flushed: true });
            toolCfg = pendingTools.config;
            showToast(
              toolCfg?.mode === "custom"
                ? t("timeline.toolsFilterApplied", { count: toolCfg.enabledToolIds?.length ?? 0 })
                : t("timeline.toolsFilterCleared"),
            );
          } else {
            toolCfg = await ctx.sessions.readToolConfig(sessionPath);
          }
          if (toolCfg?.mode === "custom") {
            // 只认 enabledToolIds——与 tool-gate 同一契约,不回退组展开(契约见 domain
            // SessionToolConfig:组展开在 tool-manager 写偏好时完成,消费方各自展开=逻辑重复)。
            // 空数组=全禁,无工具可列,不注入。
            const enabledTools = toolCfg.enabledToolIds ?? [];
            // tool-gate 底座扩展已装:跳过 prompt 注入(扩展硬过滤;注入文本持久化进会话历史,能免则免)。
            // 探测走 kernel.toolgateAvailable IPC(installer 已在底座目录同步 extension;探测失败回退软过滤)。
            const gateInstalled = await ctx.kernel.toolgateAvailable().catch(() => false);
            if (enabledTools.length > 0 && !gateInstalled) {
              finalText = `${buildToolLimitNote(enabledTools)}\n\n${text}`;
            }
          }
        } catch { /* 工具配置读取失败则不加限制,照常发送 */ }
      }
      setInput("");
      await store.sendText(currentCwd, finalText, text);
    } catch (err) {
      console.error("[sessions] \u53d1\u9001\u5931\u8d25:", err);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const composer = matchedPolicy
    ? (
      <div
        className="flex items-center justify-center w-full rounded-[var(--radius-md)]"
        style={{
          minHeight: "52px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          opacity: 0.6,
        }}
      >
        <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)] px-4 py-3">
          {matchedPolicy.readonlyMessageKey ? t(matchedPolicy.readonlyMessageKey) : t("shell.composerReadonly")}
        </span>
      </div>
    )
    : (
      <Composer
        value={input}
        onValueChange={setInput}
        onSubmit={send}
        sending={sending}
        streaming={streaming}
        onStop={() => void ctx.messaging.abort()}
        models={models}
        levels={levels}
        currentModel={currentModel}
        currentLevel={currentLevel}
        stats={stats}
        onPickModel={pickModel}
        onPickLevel={pickLevel}
        commands={snapshot?.commands ?? []}
      />
    );

  if (!currentCwd || (!switching && !messages.some((m) => m.role === "user"))) {
    return (
    <div className="flex-1 flex flex-col min-h-0 relative"
      style={{
        "--font-size-xs": "calc(var(--font-size-xs-raw) * var(--timeline-font-scale, 1))",
        "--font-size-sm": "calc(var(--font-size-sm-raw) * var(--timeline-font-scale, 1))",
        "--font-size-base": "calc(var(--font-size-base-raw) * var(--timeline-font-scale, 1))",
        "--font-size-lg": "calc(var(--font-size-lg-raw) * var(--timeline-font-scale, 1))",
      } as React.CSSProperties}
    >
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <svg viewBox="0 0 800 800" className="w-40 h-40 md:w-48 md:h-48 text-[var(--color-fg)]" aria-label="pi logo">
            <path fill="currentColor" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z" />
            <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
          </svg>
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
        data={visibleMessages}
        initialTopMostItemIndex={Math.max(0, visibleMessages.length - 1)}
        followOutput={(atBottom) => (atBottom ? "auto" : false)}
        alignToBottom
        atBottomStateChange={(atBottom) => {
          setAtBottom(atBottom);
          if (atBottom) scrollBridge.clearUnread();
        }}
        computeItemKey={(_, m) => m.id ?? String(_)}
        className="scrollbar-hidden"
        itemContent={(index, m) => (
          <div className="w-full max-w-[900px] mx-auto px-5 md:px-8">
            <div className={index === 0 ? "pt-8 pb-3" : "py-3"}>
              <MessageRow message={m} streaming={streaming} collapseDefault={collapseDefault} />
              {rewindTarget && rewindTarget.message.id === m.id && m.role === "user" && (
                <div data-rewind-inline className="mt-2" onKeyDown={(e) => { if (e.key === "Escape" && !rewindSending) { e.preventDefault(); closeRewind(); } }}>
                  <Composer
                    value={rewindText}
                    onValueChange={setRewindText}
                    onSubmit={handleRewindSend}
                    sending={rewindSending}
                    streaming={streaming}
                    onStop={handleRewindStop}
                    models={models}
                    levels={levels}
                    currentModel={currentModel}
                    currentLevel={currentLevel}
                    onPickModel={pickModel}
                    onPickLevel={pickLevel}
                  />
                </div>
              )}
            </div>
          </div>
        )}
        components={{
          Footer: () => (
            <div className="w-full max-w-[900px] mx-auto px-5 md:px-8 pb-48">
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
        {toast && (
          <div key={toast.key} style={toastStyle}>
            <Wrench className="size-3 text-[var(--color-muted)]" />
            <span>{toast.text}</span>
          </div>
        )}
        {!isAtBottom && visibleMessages.length > 0 && (
          <JumpToBottomButton
            unreadCount={scrollBridge.unreadCount}
            onClick={() => {
              virtuosoRef.current?.scrollToIndex({ index: visibleMessages.length - 1, behavior: "auto" });
              setAtBottom(true);
              scrollBridge.clearUnread();
            }}
          />
        )}
        {composer}
      </ComposerDock>
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message, streaming, collapseDefault }: { message: NeutralMessage; streaming: boolean; collapseDefault: boolean }): React.ReactNode {
  const { t } = useTranslation();
  // 用户消息剥掉 send() 注入的工具限制前缀——那是给模型的指令,不是给用户看的
  const text = message.role === "user" ? stripToolLimitNote(textOf(message.content)) : textOf(message.content);

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
      <div className="group">
        <UserBubble text={text} />
        <MessageActions message={message} text={text} />
      </div>
    );
  }

  if (message.role === "assistant") {
    const tools = toolCallsOf(message.content);
    const thinkings = thinkingBlocksOf(message.content);
    // 流式光标只看本消息的 pending(单一语义:"该条消息流式进行中",
    // 由 applyEvent 生命周期维护:占位/start/update 置 true、messageEnd 清 false)。
    // 不 OR 全局 streaming——那是 pending 断裂期的代偿,会把光标广播到全部历史消息。
    const isStreaming = message.pending === true;
    return (
      <div className="group relative">
        {thinkings.map((tc, i) => (
          <ThinkingChainBlock
            key={i}
            content={tc}
            streaming={isStreaming}
            startedAt={message.timestamp}
            completedAt={isStreaming ? undefined : message.timestamp}
            collapseDefault={collapseDefault}
          />
        ))}
        {tools.map((tc, i) => <ToolCardRenderer key={tc.id ?? i} toolCall={tc} collapseDefault={collapseDefault} />)}
        {text
          ? <Markdown text={text} streaming={isStreaming} />
          : tools.length === 0 && thinkings.length === 0 && !message.error && (
            <div className="text-[var(--color-muted)]">{t("shell.emptyMessage")}</div>
          )}
        {message.stopped && (
          <div className="text-[length:var(--font-size-sm)] text-[var(--color-accent-error)] italic mt-1">
            {t("shell.stopped")}
          </div>
        )}
        {message.error && (
          <div className="text-[length:var(--font-size-sm)] text-[var(--color-accent-error)] mt-1">
            {t("shell.error")}
            {typeof message.errorMessage === "string" && message.errorMessage && (
              <div className="opacity-70 whitespace-pre-wrap break-all mt-0.5">{message.errorMessage}</div>
            )}
          </div>
        )}
        {text && <MessageActions message={message} text={text} />}
      </div>
    );
  }

  if (message.role === "bashExecution") {
    const cmd = String(message.command ?? "");
    const output = typeof message.output === "string" ? message.output : text;
    const exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
    return (
      <ToolCardRenderer
        collapseDefault={collapseDefault}
        toolCall={{
          name: "bash",
          args: { command: cmd, cwd: message.cwd },
          result: output,
          isError: exitCode !== null && exitCode !== 0,
        }}
      />
    );
  }

  const PluginRenderer = getMessageRenderer(message.role);
  if (PluginRenderer) {
    return <PluginRenderer message={message} streaming={streaming} />;
  }

  if (message.display === false) {
    return null;
  }

  return <ToolCardRenderer collapseDefault={collapseDefault} toolCall={{ name: String(message.name ?? message.role), args: message, result: message.content }} />;
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

function MessageActions({ message, text }: { message: NeutralMessage; text: string }): React.ReactNode {
  const slotActions = useMessageActions();
  const applicable = slotActions.filter((a) => !a.when?.role || a.when.role.includes(message.role));
  const leftActions = applicable.filter((a) => a.placement !== "right");
  const rightActions = applicable.filter((a) => a.placement === "right");
  if (applicable.length === 0) return null;

  const render = (action: typeof leftActions[number]): React.ReactNode => {
    const Comp = resolveMessageActionComponent(action.pluginId, action.component);
    if (!Comp) return null;
    return <Comp key={`${action.pluginId}:${action.id}`} message={message} text={text} />;
  };

  return (
    <div className="flex items-center gap-1 mt-1 w-full opacity-0 group-hover:opacity-100 transition-opacity">
      {leftActions.map(render)}
      {rightActions.map(render)}
    </div>
  );
}

function ComposerDock({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <div className="absolute bottom-0 left-0 right-0 pointer-events-none">
      <div
        className="h-20"
        style={{ background: "linear-gradient(to bottom, transparent 0%, var(--color-bg) 50%, var(--color-bg) 100%)" }}
      />
      <div
        className="pointer-events-auto w-full pb-4"
        style={{ background: "var(--color-bg)" }}
      >
        <div
          className="mx-auto px-5 md:px-8 relative"
          style={{ width: "fit-content", maxWidth: "100%", minWidth: "min(768px, 100%)" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

const toastStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  width: "fit-content",
  margin: "0 auto 8px",
  padding: "6px 14px",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  boxShadow: "var(--shadow-md)",
  fontSize: "12px",
  color: "var(--color-fg)",
};

