import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { Wrench, RotateCcw } from "lucide-react";
import { useUiStore, useSessionStore,  type NeutralMessage, type ModelInfo, type ModelsConfig, usePluginContext, getMessageRenderer, useComposerPolicies, useMessageActions, resolveMessageActionComponent, getAuxParsers, type QueuedMessage } from "@pi-desktop/react";
import { parseSessionModelPrefs, MODELS_CONFIG_PATH, phaseFromView, type ChannelMeta } from "@pi-desktop/contract";
import { Composer } from "./composer";
import { BlockRenderer } from "./block-renderer";
import { decomposeMessage } from "./blocks";
import { JumpToBottomButton } from "./timeline-scroll-bridge";
import { QueueBasket } from "./queue-basket";
import { collapseRetryFailures } from "../core/retry-collapse";
import { foldToolResults } from "../core/tool-result-fold";

export const channels = ["timeline:bookmarkRequested", "timeline:scrollTo", "timeline:rewindRequested", "timeline:composerAttachments", "timeline:focusComposer"] as const;

// channel 可读描述(快捷键/命令面板类插件动态列表用;无描述则回退显示 channel 名)。
export const channelMeta: Record<string, ChannelMeta> = {
  "timeline:focusComposer": {
    label: "聚焦输入框",
    description: "把光标移入会话输入框,直接开打。",
  },
  "timeline:scrollTo": {
    label: "滚动时间线",
    description: "payload: { position: \"top\" | \"bottom\" } 滚到顶/底,或 { messageId } 跳到指定消息。",
    payloadExample: { position: "bottom" },
  },
  "timeline:rewindRequested": {
    label: "打开回退(rewind)",
    description: "payload: { message, text } 以指定消息为回退点重发。需要消息对象,一般不由快捷键直接触发。",
  },
  "timeline:bookmarkRequested": {
    label: "收藏当前消息",
    description: "把消息收进收藏并揭示收藏面板(payload 为消息对象,不传则面板只揭示不收藏)。",
  },
  "timeline:composerAttachments": {
    label: "输入框附件",
    description: "payload 为附件列表,更新输入框附件。",
  },
};

// messageActions 槽动作组件:框架按 manifest component 名在 module exports 自动匹配(§7.4),
// 必须在入口 re-export,否则 resolveMessageActionComponent 拿不到、动作按钮静默不渲。
export { CopyAction, BookmarkAction, RewindAction } from "./message-actions";

// titlebar 槽贡献组件(manifest contributes.titlebar 按名自动匹配,必须在入口 re-export)。
export { SessionStatsTitlebar } from "./stats-titlebar";

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

/** general.json 可被手改——非数/非正数回退默认;取整(line-clamp/lh 都只要整数)。 */
function lineCountOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

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

// followOutput 提为模块级常量:内联箭头每次渲染都是新引用,Virtuoso 会反复重建
// 内部的 SIZE_INCREASED 补偿监听(引用变化即重订阅,旧订阅不取消)——常量引用永远稳定。
const followWhenAtBottom = (atBottom: boolean): "auto" | false => (atBottom ? "auto" : false);

// 底部阶段指示的视觉映射(设计 docs/design/session-working-phase.md §2.4):
// 请求=灰(静默等待首 token,不 pulse)、思考=蓝紫(pulse,主色+灰合成,主题契约无紫 token)、
// 工具=绿(呼应工具卡 running 的 accent.success)、输出=蓝(primary)、压缩=灰。
// idle/retrying 不在此表:前者不显示指示,后者由重试横幅承担。
const PHASE_META: Record<string, { key: string; color: string; pulse: boolean }> = {
  requesting: { key: "shell.requesting", color: "var(--color-muted)", pulse: false },
  thinking: { key: "shell.thinking", color: "color-mix(in srgb, var(--color-primary) 65%, var(--color-muted) 35%)", pulse: true },
  toolExecuting: { key: "shell.toolExecuting", color: "var(--color-accent-success)", pulse: true },
  outputting: { key: "shell.outputting", color: "var(--color-primary)", pulse: true },
  compacting: { key: "shell.compacting", color: "var(--color-muted)", pulse: false },
};

/** 附件表面(timeline:composerAttachments)的 payload 形状——timeline 侧唯一一份类型断言。
 *  items 是输入框评论篮条目(输入态展示);promptFragment 是发送拼装的 review 块文本。 */
interface AttachmentsPayload {
  sessionKey?: string;
  items?: Array<{ id: string; messageId?: string; seq: string; quotePreview: string; comment: string }>;
  promptFragment?: string;
  /** 新评论编辑器已在 review 侧浮层自渲染(锚定选区),此处只剩互斥信号:
   *  为 true 时关掉"编辑已有评论"的内联框(两个编辑器同一时刻只许一个)。 */
  editorActive?: boolean;
  channels?: Record<string, string>;
}

export function TimelineView(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const {
    currentCwd, currentSessionPath, sessionModelPending, setSessionModelPending,
    pendingQueue, enqueueMessage, removeFromQueue, clearQueue, markQueueFailed, clearQueueFailed,
  } = useUiStore();
  const { snapshot, messages, streaming, switching, thinkingLevels, syncNonce, lastSendNonce } = useSessionStore();
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

  // 会话切换(openSession: switching true→false)或 resync(sync: syncNonce 递增)时重置滚动位置。
  // 不重置则用户上次滚动上移后 isAtBottom=false,followOutput 不触发,新消息不置底。
  useEffect(() => {
    if (!switching) {
      setAtBottom(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switching, syncNonce]);

  // 任何发送入口(sendMessage)成功后置底:行为由构造强制一致,
  // 入口(composer/rewind/notes)无需各自收尾,后续新入口天然继承。
  useEffect(() => {
    if (lastSendNonce === 0) return;
    setAtBottom(true);
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

  // 底座可用性门:挂载探测一次,缓存 false 时发送前复查自愈(用户可能刚在设置页装完)。
  // 读取失败按"可用"放行——状态通道故障不该误伤发送,真实失败由 RPC 错误链兜底。
  const [kernelAvailable, setKernelAvailable] = useState<boolean | null>(null);
  // 底座可用性探测:返回可用性供发送门判(读取失败按可用放行——状态通道故障不该误伤
  // 发送,真实失败由 RPC 错误链兑底)。
  const refreshKernelStatus = useCallback(async (): Promise<boolean> => {
    try {
      const s = await ctx.kernel.status();
      setKernelAvailable(s.available);
      return s.available;
    } catch {
      setKernelAvailable(null);
      return true;
    }
  }, [ctx]);

  // 会话流外部资源刷新统一入口:挂载时探测的一切(底座可用性 + 模型清单)收敛在此。
  // 挂载调一次,收到刷新信号(system:refreshRequested)或模型保存通知(configFileSaved
  // 按 path 匹配)后重探。根因:底座状态此前只在挂载时探测一次,装完 pi 必须
  // 重启/重挂载才恢复只读条;models 靠 configFileSaved 单点通知。收敛成一个入口,
  // 新资源挂载探测加在这里,不再逐资源加订阅。
  const refreshExternals = useCallback(async (): Promise<void> => {
    await refreshKernelStatus();
    try {
      const cfg = await ctx.modelsConfig.get<ModelsConfig>();
      setModels(toModelInfos(cfg));
    } catch { /* 配置缺失时以空列表兑底,无需提示 */ }
  }, [refreshKernelStatus, ctx]);

  useEffect(() => { void refreshExternals(); }, [refreshExternals]);

  // 统一刷新信号:操作完成方(main 侧 kernel:install / setCustomCliDir 等)广播 →
  // plugins-host 桥 system:refreshRequested → 这里重探。语义不绑具体资源——
  // 将来 tool-gate 安装等操作完成后也发同一个,订阅列表不随资源数膨胀。
  useEffect(() => {
    try {
      return ctx.events.on("system:refreshRequested", () => void refreshExternals());
    } catch { return undefined; }
  }, [ctx.events, refreshExternals]);

  // models.json 保存(configFileSaved 按 path 匹配)后重探:既有精确通知先例
  // (根因:此前只在挂载时读一次,新装机初始无模型读到空清单后永远不重读),
  // 重探动作统一走 refreshExternals。
  useEffect(() => {
    const off = ctx.events.on("system:configFileSaved", (payload) => {
      if ((payload as { path?: string })?.path === MODELS_CONFIG_PATH) void refreshExternals();
    });
    return off;
  }, [ctx.events, refreshExternals]);

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

  // 模型清单装载已并入 refreshExternals(见上):挂载 + 刷新信号 + models.json 保存
  // (configFileSaved 按 path 匹配)三个触发统一重探,不再单独维护 load。

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
  // 上下文压缩进行中状态(compactionStart 置、compactionEnd 清):设计 docs/design/session-working-phase.md
  // §2.4——compacting 与 retrying 对称的覆盖态,走视图流(onEvent 只含激活会话,天然过滤归属);
  // useSessionStore 虽也消费 compaction 事件,但只拿 compactionEnd 触发 sync,不暴露布尔,故本地维护。
  const [compacting, setCompacting] = useState(false);
  useEffect(() => {
    const off = ctx.sessions.onEvent((event) => {
      if (event.type === "compactionStart") setCompacting(true);
      if (event.type === "compactionEnd") setCompacting(false);
    });
    return off;
  }, [ctx]);
  // 切会话/resync 清残留(与 retrying 同纪律)。
  useEffect(() => { setCompacting(false); }, [currentSessionPath, syncNonce]);
  // 当前工作阶段(快照式推导):底部指示的单一状态源。覆盖态优先(retrying/compacting 有独立
  // 事件、盖过内容推导),其余由 messages+streaming 推出(设计文档 §1.2/§2.4)。
  const phase = useMemo(
    () => phaseFromView(messages, streaming, { retrying: retrying !== null, compacting }),
    [messages, streaming, retrying, compacting],
  );
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
  // 会话元数据收编框架 store(设计 docs/design/plugin-decoupling.md §4.2):
  // custom 从 sessionInfos[currentSessionPath] 取,不再整份 ctx.sessions.list 只为找一条。
  const sessionInfos = useSessionStore((s) => s.sessionInfos);
  useEffect(() => {
    if (!currentCwd || !currentSessionPath) { setSessionCustom(null); return; }
    const info = sessionInfos?.[currentSessionPath];
    setSessionCustom(info?.custom ?? null);
  }, [currentCwd, currentSessionPath, sessionInfos]);

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
  // 输入框/用户气泡的行数上限:保存即经 configFileSaved 广播重读,实时生效
  const composerMaxLines = lineCountOr(generalConfig["composerMaxLines"], 10);
  const userBubbleMaxLines = lineCountOr(generalConfig["userBubbleMaxLines"], 10);
  // 评论篮可见条数(同一通道,零订阅)
  const basketVisibleCount = Number(generalConfig["reviewBasketVisibleCount"] ?? 5);
  const visibleMessages = useMemo(
    // 底座自动重试每次失败落盘一条空 error assistant——连续同错误的折叠成一条
    // "重试 N/max" divider(core/retry-collapse),不再 N 个红条刷屏。
    () => foldToolResults(collapseRetryFailures(showHiddenMessages ? messages : messages.filter((m) => m.display !== false), retryMax)),
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

  // 排队队列复用 pendingKey 形态(活会话=sessionPath,新会话壳=`new:${cwd}`),切会话互不可见。
  const queueKey = pendingKey;
  const queue = queueKey ? (pendingQueue[queueKey] ?? []) : [];

  // 新评论浮层在 review 侧锚定选区弹出,无需滚动揭示;这里只剩互斥:
  // 浮层开 → 关掉"编辑已有评论"的内联框,同一时刻只许一个编辑器。
  const editorActive = att?.editorActive === true;
  useEffect(() => {
    if (editorActive) setInlineEdit(null);
  }, [editorActive]);

  /** 真正走 RPC 的发送序列(偏好回灌/工具过滤/乐观回显/统计)。返回是否成功;
   *  成功时由调用方负责收尾(清输入框/清队列)。 */
  const doSend = useCallback(async (text: string, attSnapshot?: QueuedMessage["attachments"]): Promise<boolean> => {
    if (!currentCwd) return false;
    // 附件来源:活篮子有货以活篮子为准(排队后用户可能增删评论);
    // 活篮子空了回落入队快照(活篮子被上一次发送消费后,队列里的评论不丢)。
    const src = (matched?.items?.length ?? 0) > 0
      ? matched
      : (attSnapshot ? { ...attSnapshot, sessionKey: curKey } : null);
    const store = useSessionStore.getState();
    try {
      const res = await store.sendMessage(currentCwd, text, {
        sendSuffix: src?.promptFragment || undefined,
      });
      if (!res.ok) {
        showToast(t("timeline.modelApplyFailed", { error: errText(res.error) }));
        return false;
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
      if (src?.channels?.sent) {
        try { ctx.events.invoke(src.channels.sent, { sessionKey: curKey }); } catch { /* review unloaded */ }
      }
      return true;
    } catch (err) {
      console.error("[sessions] 发送失败:", err);
      return false;
    }
  }, [currentCwd, curKey, matched, t, ctx]);

  /** 队列 flush:streaming 结束(自然完成或用户停止)后,把整队合并成一条发出。
   *  失败时整队标失败保留(用户重试/编辑/取消),不丢用户输入。 */
  const flushQueue = useCallback(async (): Promise<void> => {
    if (!queueKey || !currentCwd) return;
    const q = pendingQueue[queueKey] ?? [];
    if (q.length === 0 || q.some((x) => x.failed)) return;
    // 纯评论项 text 为空,合并时过滤,不留下前导/连续空行
    const merged = q.map((x) => x.text).filter((s) => s.trim().length > 0).join("\n\n");
    // 取队列里最近一份附件快照(doSend 内部仍优先活篮子)
    const snap = [...q].reverse().find((x) => (x.attachments?.items?.length ?? 0) > 0)?.attachments;
    if (!merged && !snap) {
      // 全空队列(理论上不该出现):清空不发,避免空 prompt
      clearQueue(queueKey);
      return;
    }
    const ok = await doSend(merged, snap);
    if (ok) {
      clearQueue(queueKey);
      if (q.length > 1) showToast(t("timeline.queue.mergedSent", { count: q.length }));
    } else {
      markQueueFailed(queueKey, t("timeline.queue.sendFailed"));
    }
  }, [queueKey, currentCwd, pendingQueue, doSend, clearQueue, markQueueFailed, t]);

  // streaming 边沿触发 flush:true→false 时(autoRetry 中 streaming 保持 true,不会误 flush)。
  const prevStreamingRef = useRef(streaming);
  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (was && !streaming) void flushQueue();
  }, [streaming, flushQueue]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if ((!text && !hasAttachments) || sendingRef.current) return;
    if (!currentCwd) { showToast(t("shell.openFolderFirst")); return; }
    if (kernelAvailable === false) {
      // 复查自愈:用户可能刚在设置页装完底座,装好了就直接放行,不弹过期提示
      const nowOk = await refreshKernelStatus();
      if (!nowOk) { showToast(t("shell.kernelRequired")); return; }
    }
    // streaming 中按发送 = 入队(有无正文都入:纯评论是完整意图,附件快照随项携带,
    // flush 时一并拼入);输入框即时清空。
    if (streaming && queueKey) {
      const snapshot = hasAttachments && matched
        ? { items: matched.items ?? [], promptFragment: matched.promptFragment, channels: matched.channels }
        : undefined;
      enqueueMessage(
        queueKey,
        text,
        snapshot,
        text ? undefined : t("timeline.queue.commentsOnly", { count: matched?.items?.length ?? 0 }),
      );
      if (text) setInput("");
      showToast(t("timeline.queue.enqueued", { count: queue.length + 1 }));
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      const ok = await doSend(text);
      if (ok) setInput("");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // 评论确认后的焦点移交(review 编辑器 Enter = 确认入篮,随后 composer 里 Enter 发送):
  // dock 的 composer 在 DOM 序最后(rewind 内联框也带该属性),取最后一个聚焦。
  useEffect(() => {
    try {
      return ctx.events.on("timeline:focusComposer", () => {
        const els = document.querySelectorAll<HTMLElement>("[data-timeline-composer]");
        els[els.length - 1]?.focus();
      });
    } catch { return undefined; }
  }, [ctx.events]);

  // 输入框只读条:策略槽命中 / 未装底座 / 未选项目,三态共用同一呈现(composerPolicies 既有交互)。
  const readonlyBar = (text: string): React.ReactNode => (
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
        {text}
      </span>
    </div>
  );

  const composer = matchedPolicy
    ? readonlyBar(matchedPolicy.readonlyMessageKey ? t(matchedPolicy.readonlyMessageKey) : t("shell.composerReadonly"))
    : kernelAvailable === false
      ? readonlyBar(t("shell.kernelRequired"))
      : !currentCwd
        ? readonlyBar(t("shell.openFolderFirst"))
        : (
      <Composer
        value={input}
        onValueChange={setInput}
        onSubmit={send}
        sending={sending}
        streaming={streaming}
        queueCount={queue.length}
        allowEmptySubmit={hasAttachments}
        maxLines={composerMaxLines}
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
        }}
        computeItemKey={(_, m) => m.id ?? String(_)}
        className="scrollbar-hidden"
        itemContent={(index, m) => (
          <div className="w-full max-w-[900px] mx-auto px-5 md:px-8">
            <div className={index === 0 ? "pt-8 pb-3" : "py-3"}>
              <MessageRow message={m} collapseDefault={collapseDefault} bubbleMaxLines={userBubbleMaxLines} />
              {rewindTarget && rewindTarget.message.id === m.id && m.role === "user" && (
                <div data-rewind-inline className="mt-2" onKeyDown={(e) => { if (e.key === "Escape" && !rewindSending) { e.preventDefault(); closeRewind(); } }}>
                  <Composer
                    value={rewindText}
                    onValueChange={setRewindText}
                    onSubmit={handleRewindSend}
                    sending={rewindSending}
                    streaming={streaming}
                    maxLines={composerMaxLines}
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
                {phase !== "idle" && phase !== "retrying" && (
                  <div className="flex items-center gap-2 text-[var(--color-muted)] text-[length:var(--font-size-sm)]">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{
                        background: PHASE_META[phase].color,
                        animation: PHASE_META[phase].pulse ? "pulse 1.6s ease-in-out infinite" : "none",
                      }}
                    />
                    {t(PHASE_META[phase].key)}
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
        {queueKey && queue.length > 0 && (
          <QueueBasket
            items={queue}
            visibleCount={basketVisibleCount}
            onEdit={(item) => {
              // 编辑 = 取出回输入框(追加语义,与 notes fillComposer 一致)。
              if (!queueKey) return;
              removeFromQueue(queueKey, item.id);
              setInput((prev) => {
                const p = prev.trimEnd();
                return p ? `${p}\n\n${item.text}` : item.text;
              });
            }}
            onRemove={(id) => { if (queueKey) removeFromQueue(queueKey, id); }}
            onRetry={() => {
              if (!queueKey) return;
              clearQueueFailed(queueKey);
              void flushQueue();
            }}
            onClearAll={() => { if (queueKey) clearQueue(queueKey); }}
          />
        )}
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
            onClick={() => {
              virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
              setAtBottom(true);
            }}
          />
        )}
        {composer}
      </ComposerDock>
    </div>
  );
}

// streaming 不进 MessageRow 的 memo 面(根因修复):流式起止翻转曾使全部行 memo 失效、
// 完成态消息 DOM 整体替换、用户文本选区被物理摧毁——review 浮动按钮"什么时候可以"
// 的时序依赖由此而来。常规块管线的流式语义由 message.pending 自持(BlockRenderer 内),
// 全局 streaming 只有整消息渲染器(sub-agent 卡片)需要,拆壳单独订阅。
const MessageRow = memo(function MessageRow({ message, collapseDefault, bubbleMaxLines }: { message: NeutralMessage; collapseDefault: boolean; bubbleMaxLines: number }): React.ReactNode {
  const { t } = useTranslation();

  // 整消息渲染器优先(messageRenderers 槽,设计 §2.3):命中即整条交给插件,不进块管线。
  const PluginRenderer = getMessageRenderer(message.role);
  if (PluginRenderer) {
    return <SlotRenderedRow renderer={PluginRenderer} message={message} />;
  }

  const blocks = decomposeMessage(message, getAuxParsers());
  if (!blocks) return null;
  const renderBlocks = (): React.ReactNode =>
    blocks.map((b, i) => (
      <BlockRenderer
        key={b.type === "toolCall" ? (b.toolCall.id ?? i) : i}
        block={b}
        message={message}
        collapseDefault={collapseDefault}
        bubbleMaxLines={bubbleMaxLines}
      />
    ));
  // MessageActions 的 text 来自块(userText/text 块原文),动作组件不自己回读消息。
  const rowText = blocks.find((b) => b.type === "text" || b.type === "userText")?.text ?? "";

  if (message.role === "user") {
    return (
      <div className="group" data-message-id={message.id ?? undefined}>
        {renderBlocks()}
        <MessageActions message={message} text={rowText} />
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="group relative" data-message-id={message.id ?? undefined}>
        {renderBlocks()}
        {blocks.length === 0 && !message.error && (
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
        {rowText && <MessageActions message={message} text={rowText} />}
      </div>
    );
  }

  // divider / bashExecution / 未知 role:无行 chrome,逐块渲染。
  return (
    <div className="group" data-message-id={message.id ?? undefined}>
      {renderBlocks()}
    </div>
  );
});

/** 整消息渲染器的流式壳:只有走 messageRenderers 槽的行才订阅全局 streaming,
 *  常规行不进这个分支,streaming 翻转时 DOM 稳定(选区/评论按钮存活)。 */
function SlotRenderedRow({ renderer: Renderer, message }: { renderer: React.ComponentType<{ message: NeutralMessage; streaming: boolean }>; message: NeutralMessage }): React.ReactNode {
  const streaming = useSessionStore((s) => s.streaming);
  return <Renderer message={message} streaming={streaming} />;
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

  // 用户气泡右对齐,动作行随之靠右;助手行保持靠左
  return (
    <div className={`flex items-center gap-1 mt-1 w-full opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity ${message.role === "user" ? "justify-end" : ""}`}>
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

