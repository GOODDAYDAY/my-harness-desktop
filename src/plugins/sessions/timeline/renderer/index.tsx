import { useState, useEffect, useRef, useCallback, memo } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { Check, Copy, Cpu, Brain, Archive, GitBranch, Pencil, ChevronDown, ChevronRight, Bookmark, FileQuestion, Wrench, Undo2 } from "lucide-react";
import { useUiStore, useSessionStore,  type NeutralMessage, type ModelInfo, type ModelsConfig, type SessionToolConfig, usePluginContext, getMessageRenderer, useComposerPolicies, toolCallsOf } from "@pi-desktop/react";
import type { SessionInfo } from "@pi-desktop/contract";
import { Composer } from "./composer";
import { Markdown } from "./markdown";
import { ToolCardRenderer } from "./tool-cards";
import { ThinkingChainBlock, type ThinkingContent } from "./thinking-chain-block";
import { UserBubble } from "./user-bubble";
import { JumpToBottomButton, useScrollBridge } from "./timeline-scroll-bridge";

export const channels = ["timeline:bookmarkRequested", "timeline:scrollTo"] as const;

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

/** pref("provider/modelId")→结构化。modelId 可含 "/"(LiteLLM 上游路径,如
 *  "anthropic/qwen3.7-max")——先与 models 清单整体比对反查(与显示同一比较式,免解析);
 *  清单外(pref 指向已被移出配置的模型)回退首个 "/" 切分,provider 段契约上不含 "/"。 */
function resolvePrefModel(pref: string, models: ModelInfo[]): { provider: string; modelId: string } | null {
  const hit = models.find((m) => `${m.provider}/${m.id}` === pref);
  if (hit) return { provider: hit.provider, modelId: hit.id };
  const idx = pref.indexOf("/");
  if (idx <= 0 || idx === pref.length - 1) return null;
  return { provider: pref.slice(0, idx), modelId: pref.slice(idx + 1) };
}

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
  const { currentCwd, currentModelId, currentThinkingLevel, currentSessionPath, setCurrentModelId, setCurrentThinkingLevel } = useUiStore();
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
  const scrollBridge = useScrollBridge();

  // 会话切换(openSession: switching true→false)或 resync(sync: syncNonce 递增)时重置滚动位置。
  // 不重置则用户上次滚动上移后 isAtBottom=false,followOutput 不触发,新消息不置底。
  useEffect(() => {
    if (!switching) {
      setIsAtBottom(true);
      scrollBridge.scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switching, syncNonce]);

  // 切会话时清除上个会话的思考强度偏好,否则 currentThinkingLevel 跨会话泄漏
  // (A 会话改了 "low",切到 B 会话仍显 "low" 而非 B 的真实值)。
  // resync(currentSessionPath 不变)不清除——用户未发送的偏好应保留。
  useEffect(() => {
    setCurrentThinkingLevel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionPath]);

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

  const handleRewind = useCallback((message: NeutralMessage, text: string): void => {
    if (streaming) { showToast(t("shell.rewindStreamingBlocked")); return; }
    if (!message.id) return;
    if (rewindTarget?.message.id === message.id) { setRewindTarget(null); setRewindText(""); return; }
    setRewindTarget({ message });
    setRewindText(text);
  }, [streaming, t, rewindTarget]);

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
      if (event.type === "messageStart" || event.type === "messageUpdate") scrollBridge.onNewItem();
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

  const [recent, setRecent] = useState<{ provider?: string; modelId?: string; thinkingLevel?: string }>({});
  useEffect(() => {
    if (!currentCwd) { setRecent({}); return; }
    void ctx.sessions.recentSettings(currentCwd).then(setRecent).catch(() => setRecent({}));
  }, [ctx, currentCwd]);

  // 「设为默认」广播:把当前模型选择(pref,跨重启持久)切到新默认——不发 setModel:
  // 新会话底座启动即读 settings.json 默认,无 pref 残留时显示也走 snapshot,两侧自然一致;
  // 对当前已活会话,下次 send 时 pref≠snapshot 会自然对齐(见 send()),不抢跑用户正在进行的生成。
  useEffect(() => {
    const off = ctx.events.on("pi-model-manager:defaultChanged", (payload) => {
      const p = payload as { provider?: string; modelId?: string };
      if (!p.provider || !p.modelId) return;
      setCurrentModelId(`${p.provider}/${p.modelId}`);
    });
    return off;
  }, [ctx, setCurrentModelId]);

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

  const matchedPolicy = sessionCustom && composerPolicies.length > 0
    ? composerPolicies.find((p) => {
        const v = sessionCustom[p.customKey];
        return v !== undefined && v !== null;
      })
    : undefined;

  const collapseDefault = generalConfig["timelineCollapseDefault"] !== false;

  const showHiddenMessages = generalConfig["showHiddenMessages"] === true;
  const visibleMessages = showHiddenMessages ? messages : messages.filter((m) => m.display !== false);

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

  // composerApplyTiming: "onSend"(默认)=点选只记偏好,send() 时 flush;
  //                      "immediate"=点选即 RPC 到底座(打断生成、分隔线错位,见 design 文档)。
  const composerApplyTiming = String(generalConfig["composerApplyTiming"] ?? "onSend");

  // flush 失败必须显形(根因:split("/") 截断含 "/" 的 modelId 后静默 catch,
  // 下拉照显 pref、会话留在旧模型,用户零感知)——pref 回退 snapshot 真值 + toast。
  const revertModelPref = async (): Promise<void> => {
    const fresh = await ctx.sessions.sync().catch(() => null);
    const truth = fresh?.state.model;
    if (truth) setCurrentModelId(`${truth.provider}/${truth.id}`);
  };
  const revertLevelPref = async (): Promise<void> => {
    const fresh = await ctx.sessions.sync().catch(() => null);
    if (fresh?.state.thinkingLevel) setCurrentThinkingLevel(fresh.state.thinkingLevel);
  };

  const pickModel = (m: ModelInfo): void => {
    setCurrentModelId(`${m.provider}/${m.id}`);
    if (composerApplyTiming !== "immediate") return;
    void (async () => {
      try {
        await ctx.models.setModel(m.provider, m.id);
        await ctx.sessions.sync();
      } catch (err) {
        await revertModelPref();
        showToast(t("timeline.modelApplyFailed", { error: errText(err) }));
      }
    })();
  };
  const pickLevel = (l: string): void => {
    setCurrentThinkingLevel(l);
    if (composerApplyTiming !== "immediate") return;
    void (async () => {
      try {
        await ctx.models.setThinkingLevel(l);
        await ctx.sessions.sync();
      } catch (err) {
        await revertLevelPref();
        showToast(t("timeline.thinkingApplyFailed", { error: errText(err) }));
      }
    })();
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
      const snap = useSessionStore.getState().snapshot?.state;
      const prefModel = useUiStore.getState().currentModelId;
      const snapModel = snap?.model ? `${snap.model.provider}/${snap.model.id}` : null;
      if (prefModel && prefModel !== snapModel) {
        const target = resolvePrefModel(prefModel, models);
        if (target) {
          try { await ctx.models.setModel(target.provider, target.modelId); }
          catch { await revertModelPref(); }
        } else {
          await revertModelPref();
        }
      }
      const prefLevel = useUiStore.getState().currentThinkingLevel ?? String(generalConfig["defaultThinkingLevel"] ?? "high");
      const snapLevel = snap?.thinkingLevel ?? null;
      if (prefLevel !== snapLevel) {
        try { await ctx.models.setThinkingLevel(prefLevel); }
        catch { await revertLevelPref(); }
      }
      const store = useSessionStore.getState();
      await store.sendText(currentCwd, text, text);
      setRewindTarget(null);
      setRewindText("");
      setIsAtBottom(true);
      scrollBridge.scrollToBottom();
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
    setIsAtBottom(true);
    scrollBridge.scrollToBottom();
    try {
      const ui = useUiStore.getState();
      const store = useSessionStore.getState();
      const snap = store.snapshot?.state;
      const prefModel = ui.currentModelId;
      const snapModel = snap?.model ? `${snap.model.provider}/${snap.model.id}` : null;
      if (prefModel && prefModel !== snapModel) {
        const target = resolvePrefModel(prefModel, models);
        let applyErr: string | null = null;
        if (!target) {
          applyErr = prefModel; // 无法解析的 pref(只可能来自手改 general.json)
        } else {
          try {
            await ctx.models.setModel(target.provider, target.modelId);
          } catch (err) {
            applyErr = errText(err);
          }
        }
        if (applyErr) {
          await revertModelPref();
          showToast(t("timeline.modelApplyFailed", { error: applyErr }));
        }
      }
      const prefLevel = ui.currentThinkingLevel ?? String(generalConfig["defaultThinkingLevel"] ?? "high");
      const snapLevel = snap?.thinkingLevel ?? null;
      if (prefLevel !== snapLevel) {
        try {
          await ctx.models.setThinkingLevel(prefLevel);
        } catch (err) {
          await revertLevelPref();
          showToast(t("timeline.thinkingApplyFailed", { error: errText(err) }));
        }
      }
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

  if (!currentCwd || (!switching && visibleMessages.length === 0)) {
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
        followOutput={isAtBottom ? "smooth" : undefined}
        alignToBottom
        atBottomStateChange={(atBottom) => {
          setIsAtBottom(atBottom);
          if (atBottom) scrollBridge.scrollToBottom();
        }}
        computeItemKey={(_, m) => m.id ?? String(_)}
        className="scrollbar-hidden"
        itemContent={(index, m) => (
          <div className="w-full max-w-[900px] mx-auto px-5 md:px-8">
            <div className={index === 0 ? "pt-8 pb-3" : "py-3"}>
              <MessageRow message={m} streaming={streaming} collapseDefault={collapseDefault} onRewind={handleRewind} />
              {rewindTarget?.message.id === m.id && m.role === "user" && (
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
              virtuosoRef.current?.scrollToIndex({ index: visibleMessages.length - 1, behavior: "smooth" });
              scrollBridge.scrollToBottom();
            }}
          />
        )}
        {composer}
      </ComposerDock>
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message, streaming, collapseDefault, onRewind }: { message: NeutralMessage; streaming: boolean; collapseDefault: boolean; onRewind?: (message: NeutralMessage, text: string) => void }): React.ReactNode {
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
        <MessageActions message={message} text={text} onRewind={onRewind} />
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

function MessageActions({ message, text, onRewind }: { message: NeutralMessage; text: string; onRewind?: (message: NeutralMessage, text: string) => void }): React.ReactNode {
  const { t } = useTranslation();
  const { currentSessionPath } = useUiStore();
  const ctx = usePluginContext();
  const [copied, setCopied] = useState(false);

  const canBookmark = message.role === "assistant" && !!message.id && !!currentSessionPath;
  const canRewind = message.role === "user" && !!message.id && !!onRewind;
  if (!text && !canBookmark && !canRewind) return null;

  return (
    <div className="flex items-center gap-1 mt-1 w-full opacity-0 group-hover:opacity-100 transition-opacity">
      {text && (
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          title={t("shell.copy")}
          className="flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t("shell.copied") : t("shell.copy")}
        </button>
      )}
      {canRewind && (
        <button
          onClick={() => void onRewind!(message, text)}
          title={t("shell.rewind")}
          className="flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer ml-auto"
        >
          <Undo2 className="size-3.5" />
          {t("shell.rewind")}
        </button>
      )}
      {canBookmark && (
        <button
          onClick={() => {
            const preview = text.replace(/\s+/g, " ").trim().slice(0, 30) || "(empty)";
            ctx.events.emit("timeline:bookmarkRequested", { sessionPath: currentSessionPath!, entryId: message.id!, preview });
          }}
          title={t("shell.bookmark")}
          className="flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer"
        >
          <Bookmark className="size-3.5" />
          {t("shell.bookmark")}
        </button>
      )}
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

