import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { Cpu, Brain, Archive, GitBranch, Pencil, ChevronDown, ChevronRight, Bookmark, FileQuestion, Wrench, RotateCcw } from "lucide-react";
import { useUiStore, useSessionStore,  type NeutralMessage, type ModelInfo, type ModelsConfig, usePluginContext, getMessageRenderer, useComposerPolicies, toolCallsOf, useMessageActions, resolveMessageActionComponent, stripToolLimitNote, type EchoAttachment } from "@pi-desktop/react";
import { parseSessionModelPrefs, type SessionInfo } from "@pi-desktop/contract";
import { Composer } from "./composer";
import { Markdown } from "./markdown";
import { ToolCardRenderer } from "./tool-cards";
import { ThinkingChainBlock, type ThinkingContent } from "./thinking-chain-block";
import { UserBubble } from "./user-bubble";
import { JumpToBottomButton, useScrollBridge } from "./timeline-scroll-bridge";
import { collapseRetryFailures } from "../core/retry-collapse";

export const channels = ["timeline:bookmarkRequested", "timeline:scrollTo", "timeline:rewindRequested", "timeline:composerAttachments"] as const;

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

/** 分区字号覆盖(机制见 theme-context 注入段注释)。两 return 分支共用单源:
 *  根因修复——此前只空态分支挂了一份,消息流分支漏挂,slider 拖动无效。 */
const AREA_FONT_SIZE_STYLE = {
  "--font-size-xs": "calc(var(--font-size-xs-raw) * var(--timeline-font-scale, 1))",
  "--font-size-sm": "calc(var(--font-size-sm-raw) * var(--timeline-font-scale, 1))",
  "--font-size-base": "calc(var(--font-size-base-raw) * var(--timeline-font-scale, 1))",
  "--font-size-lg": "calc(var(--font-size-lg-raw) * var(--timeline-font-scale, 1))",
} as React.CSSProperties;

/** Electron invoke 错误剥壳("Error invoking remote method '…': Error: <原文>")→ 底座原文。 */
function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg);
  return m?.[1] ?? msg;
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

// followOutput 提为模块级常量:内联箭头每次渲染都是新引用,Virtuoso 会反复重建
// 内部的 SIZE_INCREASED 补偿监听(引用变化即重订阅,旧订阅不取消)——常量引用永远稳定。
const followWhenAtBottom = (atBottom: boolean): "auto" | false => (atBottom ? "auto" : false);

/** 附件表面(timeline:composerAttachments)的 payload 形状——timeline 侧唯一一份类型断言。
 *  items 元素与 EchoAttachment 同构:发送时整条透传为 echo 徽章数据。 */
interface AttachmentsPayload {
  sessionKey?: string;
  items?: Array<EchoAttachment & { id: string; messageId?: string }>;
  promptFragment?: string;
  editor?: { anchorMessageId?: string; quoteText: string } | null;
  channels?: Record<string, string>;
}

export function TimelineView(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { currentCwd, currentSessionPath, sessionModelPending, setSessionModelPending } = useUiStore();
  const { snapshot, messages, streaming, switching, stats, thinkingLevels, syncNonce, lastSendNonce } = useSessionStore();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // 双击闸门(根因修复):sending 是 useState,同一渲染闭包内双击两次都读到 false,
  // 两个 send() 并发跑——pref flush 各自 ensureForSend 起 pi、setContext 互相把对方
  // 的 activeProcKey 切走,撞出"pi 未启动"。ref 同步可见,第二次点击直接挡掉。
  const sendingRef = useRef(false);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const [attachments, setAttachments] = useState<Record<string, unknown> | null>(null);
  // 编辑已有评论的内联态(点击篮子意见区:滚到原文 + 内联框在该消息下方打开,
  // 编辑永远发生在原始位置)。draft 全程归本组件,保存才经 submitEdit 过通道;
  // 与新评论 editor 互斥——同一时刻只许一个内联框。
  const [inlineEdit, setInlineEdit] = useState<{ messageId?: string; commentId: string; quotePreview: string; draft: string } | null>(null);
  const _pluginsNonce = useUiStore((s) => s.pluginsNonce);
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

  // 任何发送入口(sendMessage)成功后置底清未读:行为由构造强制一致,
  // 入口(composer/rewind/notes)无需各自收尾,后续新入口天然继承。
  useEffect(() => {
    if (lastSendNonce === 0) return;
    setAtBottom(true);
    scrollBridge.clearUnread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSendNonce]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    try {
      return ctx.events.on("timeline:composerAttachments", (payload) => {
        setAttachments(payload as Record<string, unknown>);
      });
    } catch { return undefined; }
  }, [ctx.events]);

  useEffect(() => { setAttachments(null); }, [_pluginsNonce]);

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

  // 按 messageId 平滑跳原文:命中即滚;未命中(目标尚未渲染/已压缩)登记待跳,
  // 由下轮 messages 变化兜底——评论锚的 entryId 失效时静默不跳(设计 §2.5 降级)。
  const scrollToMessageId = useCallback((messageId: string): void => {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: idx, behavior: "smooth" });
    } else {
      pendingScrollRef.current = { messageId };
    }
  }, [messages]);

  useEffect(() => {
    const off = ctx.events.on("timeline:scrollTo", (payload) => {
      const p = payload as { messageId?: string; position?: "top" | "bottom" };
      if (!p.messageId && !p.position) return;
      if (p.position === "top") {
        virtuosoRef.current?.scrollToIndex({ index: 0, behavior: "smooth" });
        return;
      }
      if (p.position === "bottom") {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
        return;
      }
      if (p.messageId) scrollToMessageId(p.messageId);
    });
    return off;
  }, [ctx, scrollToMessageId]);

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
  // 底座重试上限(retry.maxRetries,底座默认 3):折叠条目的展示分母。
  const [retryMax, setRetryMax] = useState(3);
  useEffect(() => {
    let alive = true;
    void ctx.piSettings.get().then((s) => {
      if (!alive) return;
      setDefaults({
        provider: typeof s.defaultProvider === "string" ? s.defaultProvider : undefined,
        modelId: typeof s.defaultModel === "string" ? s.defaultModel : undefined,
      });
      const mr = (s.retry as { maxRetries?: unknown } | undefined)?.maxRetries;
      if (typeof mr === "number" && Number.isFinite(mr) && mr > 0) setRetryMax(mr);
    }).catch(() => {});
    return () => { alive = false; };
  }, [ctx]);

  // 底座自动重试进行中状态(autoRetryStart 置、autoRetryEnd 清):
  // streaming 在重试等待期也置位(重试视作思考中),本横幅是重试的特化呈现,取代"思考中"圆点。
  const [retrying, setRetrying] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  useEffect(() => {
    const off = ctx.sessions.onEvent((event) => {
      if (event.type === "autoRetryStart") {
        const e = event as { attempt?: number; maxAttempts?: number; errorMessage?: string };
        if (typeof e.attempt === "number" && typeof e.maxAttempts === "number") {
          setRetrying({ attempt: e.attempt, maxAttempts: e.maxAttempts, errorMessage: e.errorMessage });
        }
      }
      if (event.type === "autoRetryEnd") setRetrying(null);
    });
    return off;
  }, [ctx]);
  // 切会话/resync 清残留(上一会话的重试状态不带进新会话)。
  useEffect(() => { setRetrying(null); }, [currentSessionPath, syncNonce]);
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
  // 评论篮可见条数(通用配置,保存经 system:configFileSaved 自动重读,零订阅)
  const basketVisibleCount = Number(generalConfig["reviewBasketVisibleCount"] ?? 5);
  const visibleMessages = useMemo(
    // 底座自动重试每次失败落盘一条空 error assistant——连续同错误的折叠成一条
    // "重试 N/max" divider(core/retry-collapse),不再 N 个红条刷屏。
    () => collapseRetryFailures(showHiddenMessages ? messages : messages.filter((m) => m.display !== false), retryMax),
    [messages, showHiddenMessages, retryMax],
  );

  // 贴底跟随兜底:React 数据驱动的滚动(追加/流式更新走这里;DOM 自高变化由 Virtuoso
  // 内建 SIZE_INCREASED 补偿覆盖)。必须 align:"end"——缺省时 Virtuoso 的
  // calculateViewLocation 对长消息(item 顶部在视口上方)会算出 align:"start",
  // 把视图滚到消息顶部,与补偿机制的 align:"end" 来回拉扯。
  useEffect(() => {
    if (!isAtBottomRef.current || !virtuosoRef.current || visibleMessages.length === 0) return;
    virtuosoRef.current.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
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
      // fork 换绑新会话后统一走 sendMessage(偏好回灌 + 工具过滤 + 发送收敛一处,设计 §4.1)
      const store = useSessionStore.getState();
      const res = await store.sendMessage(currentCwd, text);
      if (!res.ok) {
        showToast(t("timeline.modelApplyFailed", { error: errText(res.error) }));
        return;
      }
      setRewindTarget(null);
      setRewindText("");
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
    if (retrying) {
      void ctx.messaging.abortRetry();
    } else {
      void ctx.messaging.abort();
    }
  };

  // 附件匹配是发送使能的一部分:篮非空时正文可空("就这些评论,你改吧"是完整意图,设计 §2.4)。
  // sessionKey 不对齐的 payload 不匹配、不显示、不拼接(切会话瞬间的时序错位防御)。
  const att = attachments as AttachmentsPayload | null;
  const curKey = currentSessionPath ?? (currentCwd ? `new:${currentCwd}` : "");
  const matched = att && att.sessionKey === curKey ? att : null;
  const hasAttachments = (matched?.items?.length ?? 0) > 0;

  // 新评论唤起即滚到被评论消息:锚定在视口外时内联框不可见,用户找不到输入框。
  // 同时关掉编辑态——两个内联框互斥,同一时刻只许一个。
  const editorAnchor = att?.editor?.anchorMessageId ?? null;
  useEffect(() => {
    if (!editorAnchor) return;
    setInlineEdit(null);
    scrollToMessageId(editorAnchor);
  }, [editorAnchor, scrollToMessageId]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if ((!text && !hasAttachments) || sendingRef.current || !currentCwd) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const store = useSessionStore.getState();
      const res = await store.sendMessage(currentCwd, text, {
        sendSuffix: matched?.promptFragment || undefined,
        echoAttachments: matched?.items,
      });
      if (!res.ok) {
        showToast(t("timeline.modelApplyFailed", { error: errText(res.error) }));
        return;
      }
      if (res.warning === "headerPrefs") {
        showToast(t("timeline.modelApplyFailed", { error: errText(res.error) }));
      }
      if (res.toolFilterFlushed) {
        showToast(
          res.toolFilterFlushed.custom
            ? t("timeline.toolsFilterApplied", { count: res.toolFilterFlushed.count })
            : t("timeline.toolsFilterCleared"),
        );
      }
      if (matched?.channels?.sent) {
        try { ctx.events.invoke(matched.channels.sent, { sessionKey: matched.sessionKey }); } catch { /* review unloaded */ }
      }
      setInput("");
    } catch (err) {
      console.error("[sessions] 发送失败:", err);
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
        allowEmptySubmit={hasAttachments}
        onStop={() => {
          if (retrying) {
            void ctx.messaging.abortRetry();
          } else {
            void ctx.messaging.abort();
          }
        }}
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
    <div className="flex-1 flex flex-col min-h-0 relative" style={AREA_FONT_SIZE_STYLE}>
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
    <div className="flex-1 flex flex-col min-h-0 relative" style={AREA_FONT_SIZE_STYLE}>
      {/* Virtuoso 弹性容器:ComposerDock 在流布局占尾部高度,本容器吸收剩余空间;
          composer 撑高 → 本容器收缩 → Virtuoso 内建 VIEWPORT_HEIGHT_DECREASING
          补偿把贴底视图重新钉底,消息随输入框同步上移。 */}
      <div className="flex-1 min-h-0">
      <Virtuoso
        ref={virtuosoRef}
        data={visibleMessages}
        initialTopMostItemIndex={Math.max(0, visibleMessages.length - 1)}
        followOutput={followWhenAtBottom}
        alignToBottom
        // 底部预留(pb-28)只需盖住 ComposerDock 的装饰渐变罩(h-20),让末条内容
        // 贴底时完整停在可读区;composer 本体在流布局,不再吃这块预留。
        // 预留必须留在末条 item 内部,不能放回 components.Footer:
        // scrollToIndex align:"end" 的落点是末条 item 底缘(不含 Footer),而 atBottom
        // 判定含 Footer 的 scrollHeight——两者永久相差 Footer 高度,置底到位
        // 即被判"不在底部",followOutput/兜底/未读状态机全部自锁(根因,勿回退)。
        // 阈值 40px 吸收子像素与异步内容(图片/高亮)撑高的抖动。
        atBottomThreshold={40}
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
              {(() => {
                const ed = att?.editor;
                if (ed && ed.anchorMessageId === m.id) {
                  return (
                    <ReviewInlineEditor
                      key={`${ed.anchorMessageId ?? ""}:${ed.quoteText}`}
                      quoteText={ed.quoteText}
                      onSubmit={(comment) => {
                        try { ctx.events.invoke(att?.channels?.submitNew ?? "", { anchorMessageId: ed.anchorMessageId, quoteText: ed.quoteText, comment }); } catch { /* channel may be unregistered */ }
                      }}
                      onCancel={() => {
                        try { ctx.events.invoke(att?.channels?.cancelEditor ?? "", {}); } catch { /* channel may be unregistered */ }
                      }}
                    />
                  );
                }
                if (inlineEdit && inlineEdit.messageId === m.id) {
                  return (
                    <ReviewInlineEditor
                      key={inlineEdit.commentId}
                      quoteText={inlineEdit.quotePreview}
                      initialDraft={inlineEdit.draft}
                      onSubmit={(comment) => {
                        try { ctx.events.invoke(matched?.channels?.submitEdit ?? "", { commentId: inlineEdit.commentId, comment }); } catch { /* channel may be unregistered */ }
                        setInlineEdit(null);
                      }}
                      onCancel={() => setInlineEdit(null)}
                    />
                  );
                }
                return null;
              })()}
            </div>
            {index === visibleMessages.length - 1 && (
              <div className="pb-28">
                {streaming && !retrying && (
                  <div className="flex items-center gap-2 text-[var(--color-muted)] text-[length:var(--font-size-sm)]">
                    <span className="inline-block size-2 rounded-full bg-[var(--color-muted)] animate-pulse" />
                    {t("shell.thinking")}
                  </div>
                )}
                {retrying && (
                  <div className="flex items-center gap-2 text-[var(--color-accent-error)] text-[length:var(--font-size-sm)]">
                    <RotateCcw className="size-3 animate-spin" />
                    {t("timeline.autoRetryInProgress", { attempt: retrying.attempt, max: retrying.maxAttempts })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      />
      </div>

      {switching && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg)]/70 backdrop-blur-[1px]">
          <div className="size-5 rounded-full border-2 border-[var(--color-muted)] border-t-transparent animate-spin" />
          <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("shell.switchingSession")}</div>
        </div>
      )}

      <ComposerDock>
        {matched?.items?.length ? (
          // 篮子按可见条数限高(通用配置 reviewBasketVisibleCount,36px/条);
          // chip 内 truncate 生效的前提是 flex 子项 min-w-0/max-w 受限(根因修复)。
          <div className="px-4 pt-2 pb-1 flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: `${basketVisibleCount * 36}px` }}>
            {matched.items.map((item) => (
              <div key={item.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[length:var(--font-size-sm)]">
                <span className="text-[var(--color-accent)] font-semibold flex-none">{item.seq}</span>
                <span
                  className="text-[var(--color-muted)] italic truncate max-w-[45%] hover:text-[var(--color-fg)]"
                  style={item.messageId ? { cursor: "pointer" } : undefined}
                  onClick={item.messageId ? () => scrollToMessageId(item.messageId!) : undefined}
                >❝{item.quotePreview}</span>
                <span className="text-[var(--color-muted)] flex-none">→</span>
                <span
                  className="text-[var(--color-fg)] truncate flex-1 min-w-0 cursor-text"
                  onClick={() => {
                    // 编辑回到原始位置:关掉新评论框(互斥),滚到原文,内联框预填该条意见
                    try { ctx.events.invoke(matched.channels!.cancelEditor, {}); } catch { /* channel may be unregistered */ }
                    if (item.messageId) scrollToMessageId(item.messageId);
                    setInlineEdit({ messageId: item.messageId, commentId: item.id, quotePreview: item.quotePreview, draft: item.comment });
                  }}
                >{item.comment}</span>
                <button
                  className="size-5 flex items-center justify-center flex-none rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-accent-error)] hover:bg-[var(--color-bg)] text-xs cursor-pointer"
                  onClick={() => { try { ctx.events.invoke(matched.channels!.remove, { id: item.id }); } catch { /* channel may be unregistered */ } }}
                >✕</button>
              </div>
            ))}
            <button
              className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] hover:text-[var(--color-accent-error)] self-end cursor-pointer"
              onClick={() => { try { ctx.events.invoke(matched.channels!.clearAll, {}); } catch { /* channel may be unregistered */ } }}
            >{t("shell.clearAll")}</button>
          </div>
        ) : null}
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
              virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
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
      tone={message.tone as string | undefined}
    />;
  }

  if (message.role === "user") {
    // echo 徽章:发送时随乐观消息挂载的附件预览(echoAttachments),水合存活、
    // 重扫 JSONL 后消失(降级为完整发送文本,文档 §4.3)。只读,无交互。
    const echoBadges = (Array.isArray(message.echoAttachments) ? message.echoAttachments : []) as EchoAttachment[];
    return (
      <div className="group" data-message-id={message.id ?? undefined}>
        <UserBubble text={text} />
        {echoBadges.length > 0 && (
          <div className="flex justify-end mt-1">
            <div className="flex flex-col gap-1 items-end max-w-full">
              {echoBadges.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[length:var(--font-size-xs)] text-[var(--color-muted)] max-w-full">
                  <span className="text-[var(--color-accent)] font-medium flex-none">{a.seq}</span>
                  <span className="italic truncate min-w-0">❝{a.quotePreview}</span>
                  <span className="flex-none">→</span>
                  <span className="truncate min-w-0">{a.comment}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <MessageActions message={message} text={text} />
      </div>
    );
  }

  if (message.role === "assistant") {
    const tools = toolCallsOf(message.content);
    const thinkings = thinkingBlocksOf(message.content);
    const isStreaming = message.pending === true;
    return (
      <div className="group relative" data-message-id={message.id ?? undefined}>
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
  retry: <RotateCcw className="size-3" />,
};

function EntryDivider({ kind, i18nKey, i18nArgs, detail, tone }: {
  kind: string; i18nKey: string; i18nArgs?: Record<string, unknown>; detail?: string; tone?: string;
}): React.ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const text = t(i18nKey, i18nArgs);
  const colorClass = tone === "error" ? "text-[var(--color-accent-error)]" : "text-[var(--color-muted)]";
  return (
    <div className="select-none">
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-[var(--color-border)]" />
        <button
          onClick={() => detail && setOpen(!open)}
          className={`flex items-center gap-1.5 text-xs ${colorClass} bg-transparent border-none p-0 ${detail ? "cursor-pointer hover:text-[var(--color-fg)]" : "cursor-default"}`}
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
    <div className="flex items-center gap-1 mt-1 w-full opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      {leftActions.map(render)}
      {rightActions.map(render)}
    </div>
  );
}

function ComposerDock({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    // 在流布局:占 flex 列尾部,高度随 composer 内容(textarea field-sizing)伸缩。
    // 根因修复——原 absolute bottom-0 悬浮 + 末条固定 pb-48 预留,composer 撑过
    // 192px 即盖住消息;改在流后 composer 撑高 → Virtuoso 视口收缩 → 内建
    // VIEWPORT_HEIGHT_DECREASING 补偿钉底,消息同步上移,任何高度都不再遮挡。
    <div className="relative shrink-0 pointer-events-none">
      {/* 渐变罩:纯装饰,悬在滚动区底缘之上不占布局,消息在其下滚过时渐隐 */}
      <div
        className="absolute bottom-full left-0 right-0 h-20"
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
  fontSize: "var(--font-size-sm)",
  color: "var(--color-fg)",
};

/** 消息行下方的内联评论输入框(data-review-inline,rewind 内联框先例)。
 *  draft 收在本组件:提交/取消才过通道,打字零事件流量;key 随锚定消息与引文
 *  变化即重置,切目标不串草稿。失焦语义(点击外部):有内容放回去(提交),
 *  没有就丢弃(取消)。 */
function ReviewInlineEditor({ quoteText, initialDraft = "", onSubmit, onCancel }: {
  quoteText: string;
  initialDraft?: string;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialDraft);
  return (
    <div data-review-inline className="mt-2 rounded-[var(--radius-md)] border border-[var(--color-accent)] border-l-2 bg-[var(--color-surface)] p-3">
      <div className="text-[var(--color-muted)] italic text-[length:var(--font-size-xs)] mb-2">❝ {quoteText}</div>
      <textarea
        autoFocus
        className="w-full bg-transparent text-[var(--color-fg)] text-[length:var(--font-size-sm)] resize-none outline-none border-none"
        rows={2}
        placeholder={t("shell.placeholder")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const comment = draft.trim();
          if (comment) onSubmit(comment); else onCancel();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const comment = draft.trim();
            if (!comment) return;
            onSubmit(comment);
          }
          if (e.key === "Escape") onCancel();
        }}
      />
    </div>
  );
}

