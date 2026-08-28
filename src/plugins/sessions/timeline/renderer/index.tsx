import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { Virtuoso, type VirtuosoHandle, type ListRange } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { Wrench, RotateCcw, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useUiStore, useSessionStore,  type NeutralMessage, type ModelInfo, usePluginContext, getMessageRenderer, useComposerPolicies, useComposerAttachments, useComposerActions, useComposerStats, useComposerTop, useComposerVoice, useMessageActions, resolveMessageActionComponent, getAuxParsers, getComposerCommands, runComposerCommandIfMatch, PluginIdContext, type QueuedMessage, type ComposerAttachmentProps, type ComposerVoiceProps, getPluginComponent, PluginIcon } from "@my-harness-desktop/react";
import { parseSessionModelPrefs, MODELS_CONFIG_PATH, phaseFromView, type ChannelMeta, type ComposerAttachmentPayload, type KernelId, type CommandItem } from "@my-harness-desktop/shared";
import { Composer } from "./composer";
import { BlockRenderer } from "./block-renderer";
import { ImageBlock } from "./image-block";
import { decomposeMessage } from "./blocks";
import { JumpToBottomButton } from "./timeline-scroll-bridge";
import { QueueBasket } from "./queue-basket";
import { collapseRetryFailures } from "../core/retry-collapse";
import { foldToolResults } from "../core/tool-result-fold";
import { parseImageContent } from "../core/attach-images";
import { MessageMeta } from "./MessageMeta";
import { useSessionDraft } from "./use-session-draft";

export const channels = ["timeline:scrollTo", "timeline:rewindRequested", "timeline:composerAttachments", "timeline:focusComposer", "timeline:cycleModel", "timeline:cycleThinking"] as const;

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
  "timeline:composerAttachments": {
    label: "输入框附件",
    description: "payload 为附件列表,更新输入框附件。",
  },
  "timeline:cycleModel": {
    label: "切换模型",
    description: "payload: { direction?: 1 | -1 } 在模型清单中循环切换(默认下一个)。",
    payloadExample: { direction: 1 },
  },
  "timeline:cycleThinking": {
    label: "切换思考深度",
    description: "payload: { direction?: 1 | -1 } 在思考深度清单中循环切换(默认下一个)。",
    payloadExample: { direction: 1 },
  },
};

// messageActions 槽动作组件:框架按 manifest component 名在 module exports 自动匹配(§7.4),
// 必须在入口 re-export,否则 resolveMessageActionComponent 拿不到、动作按钮静默不渲。
// fork/收藏动作已迁 session-bookmarks(§bookmark-snapshot-fork-unify §5),此处只留 copy/rewind。
export { CopyAction, RewindAction } from "./message-actions";

const DEFAULT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
// 空态欢迎语随机句总数(对应 shell.greeting.1..20 的 i18n key,每次随机取一句)。
const GREETING_COUNT = 20;

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

/** Electron invoke 错误剥壳("Error invoking remote method '…': Error: <原文>")→ 内核原文。 */
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

/** 附件表面(timeline:composerAttachments)的 payload 形状——契约单源在圆心
 *  ComposerAttachmentPayload(设计 docs/design/plugin-decoupling.md §5.2),timeline 不再本地定义。
 *  渲染归位后(channels 字段已删):timeline 只挂载数据,谁画由 composerAttachments 槽贡献方决定。 */

export function TimelineView(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const {
    currentCwd, currentNeutralSessionId, sessionModelPending, setSessionModelPending,
    pendingQueue, enqueueMessage, removeFromQueue, clearQueue, markQueueFailed, markQueueItemFailed, clearQueueFailed,
  } = useUiStore();
  const { snapshot, messages, streaming, switching, thinkingLevels, capabilities, syncNonce, openNonce, lastSendNonce } = useSessionStore();
  // 输入框草稿按会话 key 隔离:活会话=neutralSessionId,新会话壳=`new:${cwd}`。
  // 保存/恢复逻辑在 useSessionDraft(见 use-session-draft.ts,可 DOM e2e 单测)。
  const draftKey = currentNeutralSessionId ?? (currentCwd ? `new:${currentCwd}` : null);
  const [input, setInput] = useSessionDraft(draftKey);
  // 供 sendText 读最新输入框内容(判断「发的是不是输入框内容」决定是否清输入框),
  // 避免 sendText 依赖 input state 导致 stickers:send 订阅随每次按键重建。
  const inputRef = useRef(input);
  inputRef.current = input;
  const [sending, setSending] = useState(false);
  // 双击闸门(根因修复):sending 是 useState,同一渲染闭包内双击两次都读到 false,
  // 两个 send() 并发跑——pref flush 各自 ensureForSend 起 pi、setContext 互相把对方
  // 的 activeProcKey 切走,撞出"pi 未启动"。ref 同步可见,第二次点击直接挡掉。
  const sendingRef = useRef(false);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachmentPayload | null>(null);
  // composer 挂图(表情包"加入输入框"的待发送图):state 驱动渲染,ref 供 doSend 消费取走
  // (发送动作在 useCallback 里,ref 同步可见;state 只在渲染层用)。发送成功才清。
  // dataUri 由贡献方(stickers)读文件提供,timeline 只挂载渲染不碰文件读取。
  const [composerImage, setComposerImage] = useState<{ src: string; title?: string; dataUri?: string } | null>(null);
  const composerImageRef = useRef<{ src: string; title?: string } | null>(null);
  const setPendingImage = useCallback((img: { src: string; title?: string; dataUri?: string } | null): void => {
    composerImageRef.current = img ? { src: img.src, title: img.title } : null;
    setComposerImage(img);
  }, []);
  const _pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const pendingScrollRef = useRef<{ messageId?: string; position?: "top" | "bottom" } | null>(null);
  // 当前渲染范围(rangeChanged 记录):scrollTo 目标在范围内 = 已在视口,不滚——
  // 停在消息打开的地方;不在范围才滚过去。缺省 align:"start" 会把可见消息顶到视口顶部。
  const visibleRangeRef = useRef<ListRange | null>(null);
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
        setAttachments(payload as ComposerAttachmentPayload);
      });
    } catch { return undefined; }
  }, [ctx.events]);

  useEffect(() => { setAttachments(null); }, [_pluginsNonce]);

  const showToast = useCallback((text: string): void => setToast({ key: Date.now(), text }), []);

  // 内核可用性门:挂载探测一次,缓存 false 时发送前复查自愈(用户可能刚在设置页装完)。
  // 读取失败按"可用"放行——状态通道故障不该误伤发送,真实失败由 RPC 错误链兜底。
  // 门按「当前模型的归属内核」探测(§7.6 能力探测):选 dsh 模型时问 dsh 可用性,
  // 不再 pi 一刀切(此前只装了 dsh 也能选 dsh 模型,却被 pi 未装挡住发送)。
  const [kernelAvailable, setKernelAvailable] = useState<boolean | null>(null);
  // 当前模型内核的同步镜像(供 refreshExternals 等回调读最新值,不依赖闭包)。
  const currentKernelRef = useRef<KernelId | null>(null);
  // 内核可用性探测:返回可用性供发送门判(读取失败按可用放行——状态通道故障不该误伤
  // 发送,真实失败由 RPC 错误链兜底)。不传内核 = 探当前模型归属内核。
  const refreshKernelStatus = useCallback(async (kernel?: KernelId): Promise<boolean> => {
    const k = kernel ?? currentKernelRef.current ?? "pi";
    try {
      const s = await ctx.kernels[k].status();
      setKernelAvailable(s.available);
      return s.available;
    } catch {
      setKernelAvailable(null);
      return true;
    }
  }, [ctx]);

  // 会话流外部资源刷新统一入口:挂载时探测的一切(内核可用性 + 模型清单)收敛在此。
  // 挂载调一次,收到刷新信号(system:refreshRequested)或模型保存通知(configFileSaved
  // 按 path 匹配)后重探。根因:内核状态此前只在挂载时探测一次,装完 pi 必须
  // 重启/重挂载才恢复只读条;models 靠 configFileSaved 单点通知。收敛成一个入口,
  // 新资源挂载探测加在这里,不再逐资源加订阅。
  const refreshExternals = useCallback(async (): Promise<void> => {
    // models 与默认配置层(piSettings)并行装载、同批 setState:两条异步源原子落地,
    // currentModel 链一次性解析到位——既无"先 models[0] 再默认"的两段闪跳,也无需
    // defaultsLoaded 门控(门控会让模型位空等 defaults,拖慢首屏)。kernel.status 不再
    // 串行挡在 models 前(根因:内核探测慢时模型清单被拖住、输入框空悬——这才是
    // "延迟"体验差的真源)。
    void refreshKernelStatus();
    // models 走合流清单(model-catalog:pi + dsh,带 kernel 标)而非只扫 pi models.json(§3.3)。
    const [settingsRes, modelsRes, fallbackRes] = await Promise.allSettled([
      ctx.piSettings.get(),
      ctx.modelsConfig.list(),
      ctx.modelsConfig.getFallbackModel(),
    ]);
    if (settingsRes.status === "fulfilled") {
      const s = settingsRes.value;
      setDefaults({
        provider: typeof s.defaultProvider === "string" ? s.defaultProvider : undefined,
        modelId: typeof s.defaultModel === "string" ? s.defaultModel : undefined,
      });
      const mr = (s.retry as { maxRetries?: unknown } | undefined)?.maxRetries;
      if (typeof mr === "number" && Number.isFinite(mr) && mr > 0) setRetryMax(mr);
    }
    if (modelsRes.status === "fulfilled") {
      setModels(modelsRes.value);
    }
    if (fallbackRes.status === "fulfilled" && fallbackRes.value) {
      setFallbackModel({ provider: fallbackRes.value.provider, modelId: fallbackRes.value.model, kernel: fallbackRes.value.kernel });
    }
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
  }, [streaming, t, rewindTarget, showToast]);

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
      // 点击 rewind 内联框、或其 portal 下拉(模型/思考强度菜单经 Radix Portal
      // 渲染到 body,不在 data-rewind-inline 的 DOM 树内)——都不算"点击外部":
      // 否则选模型时 mousedown 先于 onSelect 触发,输入框被误关(根因修复)。
      if (el?.closest("[data-rewind-inline], [role='menu']")) return;
      closeRewind();
    };
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("mousedown", onDown); };
  }, [rewindTarget, closeRewind]);

  const [models, setModels] = useState<ModelInfo[]>([]);
  // 思考档位是 pi 专属能力(§7.6):dsh 无此面 → levels 置空,composer 不画档位 dropdown + cycle 落空。
  const levels = capabilities.piExtension
    ? (thinkingLevels.length > 0 ? thinkingLevels : DEFAULT_LEVELS)
    : [];

  // 模型清单装载已并入 refreshExternals(见上):挂载 + 刷新信号 + models.json 保存
  // (configFileSaved 按 path 匹配)三个触发统一重探,不再单独维护 load。

  // 订阅 stickers 插件的"加入输入框"请求:把文本追加进 composer(用户改后手动发),
  // 有图则把图挂到 composer 上方展示(待发送)。追加而非覆盖:已有草稿不能被顶掉,
  // 之间空一行衔接多条填入。stickers 是可选插件——channel 未加载/已禁用时 on()
  // 会抛错,try/catch 兑底绝不影响 timeline 自身。
  useEffect(() => {
    try {
      return ctx.events.on("stickers:fillComposer", (payload) => {
        const p = payload as { text?: string; image?: { src?: string; title?: string; dataUri?: string } } | null;
        const text = p?.text;
        if (typeof text === "string" && text) {
          setInput((prev) => {
            const pr = prev.trimEnd();
            return pr ? `${pr}\n\n${text}` : text;
          });
        }
        const src = p?.image?.src;
        if (typeof src === "string" && src) {
          setPendingImage({ src, title: p.image?.title, dataUri: p.image?.dataUri });
        }
      });
    } catch {
      return undefined;
    }
  }, [ctx.events, setPendingImage, setInput]);

  // 默认配置层的本地镜像(设计 §2.1):只服务新会话壳的显示与 pending 种子,
  // 已活会话的任何路径都不读它。「设为默认」广播只刷新这份镜像,不写任何持久状态。
  // 装载已并入 refreshExternals(与 models 并行、同批落地,原子解析无闪跳、无门控延迟)。
  const [defaults, setDefaults] = useState<{ provider?: string; modelId?: string }>({});
  // 兜底模型(新会话无显式选择时实际会用到的模型):dsh agent-default-model 优先,否则 pi 兜底。
  // 与 main 的 models.getFallbackModel 同源;currentModel 链据此显示,不再落到 models[0] 的 pi 首项。
  const [fallbackModel, setFallbackModel] = useState<{ provider?: string; modelId?: string; kernel?: KernelId }>({});
  // 内核重试上限(retry.maxRetries,内核默认 3):折叠条目的展示分母。
  const [retryMax, setRetryMax] = useState(3);

  // 内核自动重试进行中状态(autoRetryStart 置、autoRetryEnd 清):
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
  useEffect(() => { setRetrying(null); }, [currentNeutralSessionId, syncNonce]);
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
  useEffect(() => { setCompacting(false); }, [currentNeutralSessionId, syncNonce]);
  // 当前工作阶段(快照式推导):底部指示的单一状态源。覆盖态优先(retrying/compacting 有独立
  // 事件、盖过内容推导),其余由 messages+streaming 推出(设计文档 §1.2/§2.4)。
  const phase = useMemo(
    () => phaseFromView(messages, streaming, { retrying: retrying !== null, compacting }),
    [messages, streaming, retrying, compacting],
  );
  useEffect(() => {
    const off = ctx.events.on("pi-manager:defaultChanged", (payload) => {
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
  // custom 从 sessionInfos[currentNeutralSessionId] 取,不再整份 ctx.sessions.list 只为找一条。
  const sessionInfos = useSessionStore((s) => s.sessionInfos);
  useEffect(() => {
    if (!currentCwd || !currentNeutralSessionId) { setSessionCustom(null); return; }
    const info = sessionInfos?.[currentNeutralSessionId];
    setSessionCustom(info?.custom ?? null);
  }, [currentCwd, currentNeutralSessionId, sessionInfos]);

  // 显示链(设计 §4.2):pending > 快照/头 > 默认。活会话快照是实时真相;
  // 历史会话(进程没起)读头行 model 域;新会话壳读默认配置层。
  const pendingKey = currentNeutralSessionId ?? (currentCwd ? `new:${currentCwd}` : null);
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
  const visibleMessages = useMemo(
    // 内核自动重试每次失败落盘一条空 error assistant——连续同错误的折叠成一条
    // "重试 N/max" divider(core/retry-collapse),不再 N 个红条刷屏。
    // 图片展示不在此吸附——走 messages 的 __image(中立层合入,见 MessageRow 的 user 分支)。
    () => foldToolResults(collapseRetryFailures(showHiddenMessages ? messages : messages.filter((m) => m.display !== false), retryMax)),
    [messages, showHiddenMessages, retryMax],
  );

  // 按 messageId 平滑跳原文:命中即滚;未命中(目标尚未渲染/已压缩)登记待跳,
  // 由下轮 visibleMessages 变化兜底——评论锚的 entryId 失效时静默不跳(设计 §2.5 降级)。
  // 索引对齐 Virtuoso 的 data(visibleMessages):原始 messages 经 foldToolResults 摘除
  // 已配对 toolResult、collapseRetryFailures 折叠重试失败、display:false 过滤后变短,
  // 用原始索引会滚过头。目标已在当前渲染范围(visibleRangeRef)则不滚——评论锚原本
  // 就在底部可见时,点击引用条不再把它顶到视口顶部(停在消息打开的地方)。
  const scrollToMessageId = useCallback((messageId: string): void => {
    const idx = visibleMessages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      const range = visibleRangeRef.current;
      if (!range || idx < range.startIndex || idx > range.endIndex) {
        virtuosoRef.current?.scrollToIndex({ index: idx, behavior: "smooth" });
      }
    } else {
      pendingScrollRef.current = { messageId };
    }
  }, [visibleMessages]);

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
      const idx = visibleMessages.findIndex(m => m.id === pendingScrollRef.current!.messageId);
      if (idx >= 0) {
        // 与直接命中路径同一可见性判断:目标已渲染在视口内就不滚,避免兜底滚动
        // 把可见消息顶到视口顶部(与 align 缺省 start 同一根因)。
        const range = visibleRangeRef.current;
        if (!range || idx < range.startIndex || idx > range.endIndex) {
          virtuosoRef.current?.scrollToIndex({ index: idx, behavior: "smooth" });
        }
      }
      pendingScrollRef.current = null;
    }
  }, [visibleMessages]);

  // 贴底跟随兜底:React 数据驱动的滚动(追加/流式更新走这里;DOM 自高变化由 Virtuoso
  // 内建 SIZE_INCREASED 补偿覆盖)。必须 align:"end"——缺省时 Virtuoso 的
  // calculateViewLocation 对长消息(item 顶部在视口上方)会算出 align:"start",
  // 把视图滚到消息顶部,与补偿机制的 align:"end" 来回拉扯。
  useEffect(() => {
    if (!isAtBottomRef.current || !virtuosoRef.current || visibleMessages.length === 0) return;
    virtuosoRef.current.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [visibleMessages]);

  // 模型显示只认 models.json 已配置清单:任何解析源(快照/头行/默认)引用的模型
  // 不在配置清单里就返回 null(不合成兜底对象)——否则内核 get_state 的内置回落模型
  // (实证 anthropic/claude-opus-4-8)会在用户没配模型时露出来(与 session-store
  // spawn 回落注释同源)。
  // 模型身份 = (kernel, provider, id)——按三者全匹配,不做 provider+id 反查(pi/dsh 同名歧义)。
  const toModelInfoFallback = (provider: string, modelId: string, kernel?: KernelId): ModelInfo | null =>
    kernel ? (models.find((m) => m.kernel === kernel && m.provider === provider && m.id === modelId) ?? null) : null;
  // 活会话快照是实时真相,但同样过配置清单校验——内核可能报出未配置的内置回落模型。
  const snapshotModel = snapshot?.state.model
    ? toModelInfoFallback(snapshot.state.model.provider, snapshot.state.model.id, snapshot.state.model.kernel)
    : null;
  // 展示链优先级:显式意图(pending)→ 活会话实况(快照)→ 会话头持久域 → 应用级默认模型
  // (getFallbackModel,带内核归属)→ pi settings 默认(仅 pi 语义,排在应用级默认之后)→ 清单首项。
  // 应用级默认先于 pi 默认:此前 pi settings 默认把 dsh 默认模型盖住,新会话显示成 pi 模型、
  // 内核标误导成 pi(「选了 dsh 却像在用 pi」的显示层根因)。
  const currentModel =
    (pending ? toModelInfoFallback(pending.provider, pending.modelId, pending.kernel) : null)
    ?? snapshotModel
    ?? (headerPrefs ? toModelInfoFallback(headerPrefs.provider, headerPrefs.modelId, headerPrefs.kernel) : null)
    ?? (fallbackModel.provider && fallbackModel.modelId ? toModelInfoFallback(fallbackModel.provider, fallbackModel.modelId, fallbackModel.kernel) : null)
    ?? (defaults.provider && defaults.modelId ? toModelInfoFallback(defaults.provider, defaults.modelId, "pi") : null)
    ?? models[0]
    ?? null;
  // 内核可用性门跟随当前模型归属内核:模型链解析/切换后重探对应内核状态。
  currentKernelRef.current = currentModel?.kernel ?? null;
  useEffect(() => {
    if (currentModel?.kernel) void refreshKernelStatus(currentModel.kernel);
  }, [currentModel?.kernel, refreshKernelStatus]);
  // 空态欢迎语随机句:进入空态/切目录/新会话/切内核时随机换一句(惰性初始化防首帧闪)。
  const [greetingIdx, setGreetingIdx] = useState(() => Math.floor(Math.random() * GREETING_COUNT) + 1);
  const greetingInitRef = useRef(true);
  useEffect(() => {
    if (greetingInitRef.current) { greetingInitRef.current = false; return; }
    setGreetingIdx(Math.floor(Math.random() * GREETING_COUNT) + 1);
  }, [currentCwd, currentNeutralSessionId, currentModel?.kernel]);
  const configDefault = generalConfig["defaultThinkingLevel"];
  const configDefaultStr = typeof configDefault === "string" && configDefault ? configDefault : null;
  const currentLevel =
    pending?.thinkingLevel
    ?? snapshot?.state.thinkingLevel
    ?? headerPrefs?.thinkingLevel
    ?? configDefaultStr
    ?? "high";

  // composerApplyTiming: "onSend"(默认)=点选只记内存 pending,send() 时回灌;
  //                      "immediate"=点选即 RPC 到内核(打断生成、分隔线错位,见 design 文档)。
  const composerApplyTiming = String(generalConfig["composerApplyTiming"] ?? "onSend");

  const pickModel = (m: ModelInfo): void => {
    if (composerApplyTiming === "immediate") {
      void (async () => {
        try {
          // 模型项自带内核标:m.kernel 透传给 setModel,不反查。
          await ctx.models.setModel(m.provider, m.id, m.kernel);
          await ctx.sessions.sync();
        } catch (err) {
          // 失败显形(设计 §4.1 失败路径):sync 取真值,显示随快照回落。
          showToast(t("timeline.modelApplyFailed", { error: errText(err) }));
          void ctx.sessions.sync().catch(() => {});
        }
      })();
      return;
    }
    // onSend:记内存 pending(含内核标 m.kernel,send 时透传给 setModel,不反查)。
    if (pendingKey) {
      setSessionModelPending(pendingKey, { provider: m.provider, modelId: m.id, thinkingLevel: currentLevel, kernel: m.kernel });
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
    // onSend:已有 pending 换档;无 pending 以当前显示模型为种子凑全字段。
    const provider = pending?.provider ?? currentModel?.provider;
    const modelId = pending?.modelId ?? currentModel?.id;
    if (pendingKey && provider && modelId) {
      // 内核标必须随 pending 一起带(§kernel-follows-model):换档不能丢 kernel,
      // 否则 send 回灌 prefs.kernel 缺失 → prompt 报「模型未携带内核归属」。
      setSessionModelPending(pendingKey, { provider, modelId, thinkingLevel: l, kernel: pending?.kernel ?? currentModel?.kernel });
    }
  };

  // 快捷键循环切换(timeline:cycleModel / cycleThinking)需要的最新状态与动作:
  // 订阅 effect 只挂一次,经 ref 读最新值——避免每次渲染重建订阅(闭包旧值防线)。
  const cycleStateRef = useRef({ models, levels, currentModel, currentLevel });
  cycleStateRef.current = { models, levels, currentModel, currentLevel };
  const pickModelRef = useRef(pickModel);
  pickModelRef.current = pickModel;
  const pickLevelRef = useRef(pickLevel);
  pickLevelRef.current = pickLevel;

  // 循环切换模型:在 models 清单中找当前模型的下一个/上一个,走 pickModel(与点选同一
  // 处理链:composerApplyTiming 两种模式、pending 回灌、失败 toast 全部原样生效)。
  useEffect(() => {
    const off = ctx.events.on("timeline:cycleModel", (payload) => {
      const dir = (payload as { direction?: number } | null)?.direction ?? 1;
      const { models: ms, currentModel: cm } = cycleStateRef.current;
      if (!ms.length || !cm) return;
      const idx = ms.findIndex((m) => m.kernel === cm.kernel && m.provider === cm.provider && m.id === cm.id);
      const step = dir >= 0 ? 1 : -1;
      const next = ms[(idx === -1 ? 0 : idx + step + ms.length) % ms.length];
      pickModelRef.current(next);
    });
    return off;
  }, [ctx.events]);

  // 循环切换思考深度:在 levels 清单中找当前深度的下一个/上一个,走 pickLevel。
  useEffect(() => {
    const off = ctx.events.on("timeline:cycleThinking", (payload) => {
      const dir = (payload as { direction?: number } | null)?.direction ?? 1;
      const { levels: ls, currentLevel: cl } = cycleStateRef.current;
      if (!ls.length) return;
      const idx = ls.indexOf(cl);
      const step = dir >= 0 ? 1 : -1;
      const next = ls[(idx === -1 ? 0 : idx + step + ls.length) % ls.length];
      pickLevelRef.current(next);
    });
    return off;
  }, [ctx.events]);

  const handleRewindSend = async (): Promise<void> => {
    const text = rewindText.trim();
    if (!text || rewindSendingRef.current || !currentCwd || !rewindTarget?.message.id) return;
    rewindSendingRef.current = true;
    setRewindSending(true);
    try {
      try {
        await ctx.tree.fork(currentNeutralSessionId ?? "", rewindTarget.message.id);
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
    if (retrying && capabilities.piExtension) {
      void ctx.pi.abortRetry();
    } else {
      void ctx.messaging.abort();
    }
  };

  // 附件匹配是发送使能的一部分:篮非空时正文可空("就这些评论,你改吧"是完整意图,设计 §2.4)。
  // sessionKey 不对齐的 payload 不匹配、不显示、不拼接(切会话瞬间的时序错位防御)。
  const att = attachments;
  const curKey = currentNeutralSessionId ?? (currentCwd ? `new:${currentCwd}` : "");
  const matched = att && att.sessionKey === curKey ? att : null;
  const hasAttachments = (matched?.items?.length ?? 0) > 0;

  // 附件渲染槽(设计 §5.2):查槽取贡献组件(谁的数据谁画);数据仍经 composerAttachments 事件挂载。
  const attachmentContribs = useComposerAttachments();
  const AttachmentRenderer = useMemo(() => {
    for (const c of attachmentContribs) {
      const Comp = getPluginComponent(c.pluginId, c.component) as React.ComponentType<ComposerAttachmentProps> | undefined;
      if (Comp) return Comp;
    }
    return undefined;
  }, [attachmentContribs]);

  // composerActions 槽:composer 底部工具栏的按钮(表情包快速入口等),渲染进 Composer 的 children。
  // PluginIdContext 按贡献方 pluginId 包裹(与 settings/sidebar 等槽消费者同款)——
  // 否则组件落在 timeline 的上下文里,emit/config 等 pluginId 绑定面全部错认成 timeline。
  const composerActionContribs = useComposerActions();
  const composerActionButtons = useMemo(() => {
    const out: React.ReactNode[] = [];
    for (const c of composerActionContribs) {
      const Comp = getPluginComponent(c.pluginId, c.component) as React.ComponentType | undefined;
      if (Comp) out.push(<PluginIdContext.Provider key={c.id} value={c.pluginId}><Comp /></PluginIdContext.Provider>);
    }
    return out;
  }, [composerActionContribs]);

  // composerStats 槽:composer 中段的状态指示组件(上下文占用条等)。领域归属 token-stats
  // 插件,timeline 只提供挂载点——查槽取贡献组件,不再硬编码任何统计组件(§1.2 机制与内容分离)。
  const composerStatsContribs = useComposerStats();
  const composerStatsNodes = useMemo(() => {
    const out: React.ReactNode[] = [];
    for (const c of composerStatsContribs) {
      const Comp = getPluginComponent(c.pluginId, c.component) as React.ComponentType | undefined;
      if (Comp) out.push(<PluginIdContext.Provider key={c.id} value={c.pluginId}><Comp /></PluginIdContext.Provider>);
    }
    return out;
  }, [composerStatsContribs]);

  // pluginsNonce:插件集合版本号(热装/卸载递增)。下方两处键控重读/重订的失效键——
  // composerTop 槽组件匹配、斜杠命令清单、goal:state 订阅重试都靠它。声明前置避免 TDZ。
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);

  // composerTop 槽:输入框上方的横幅组件(目标条等"进行态展示"),渲染进 ComposerDock 顶部。
  // 与附件停靠区的分工:附件是待发送内容(数据经通道),本槽是常驻状态(贡献方自持数据)。
  const composerTopContribs = useComposerTop();
  const composerTopNodes = useMemo(() => {
    const out: React.ReactNode[] = [];
    for (const c of composerTopContribs) {
      const Comp = getPluginComponent(c.pluginId, c.component) as React.ComponentType | undefined;
      if (Comp) out.push(<PluginIdContext.Provider key={c.id} value={c.pluginId}><Comp /></PluginIdContext.Provider>);
    }
    return out;
  }, [composerTopContribs]);

  // composerVoice 槽:composer 右下角的语音输入按钮(STT 语音转文字等)。首个贡献胜出(单一按钮槽)。
  // 与其它 composer* 槽不同:本槽组件带 onTranscribed 回调——语音转文字的结果要写回输入框,
  // 不能靠组件自订阅 store 完成。追加语义与 stickers:fillComposer 一致(已有草稿不被顶掉)。
  const composerVoiceContribs = useComposerVoice();
  const composerVoiceNode = useMemo(() => {
    for (const c of composerVoiceContribs) {
      const Comp = getPluginComponent(c.pluginId, c.component) as React.ComponentType<ComposerVoiceProps> | undefined;
      if (Comp) {
        return (
          <PluginIdContext.Provider key={c.id} value={c.pluginId}>
            <Comp
              onTranscribed={(text) => {
                setInput((prev) => {
                  const pr = prev.trimEnd();
                  return pr ? `${pr}\n\n${text}` : text;
                });
              }}
            />
          </PluginIdContext.Provider>
        );
      }
    }
    return undefined;
  }, [composerVoiceContribs, setInput]);

  // goal 生效着色:订阅 goal 插件的 goal:state 状态广播(replayLast 回放当前态),
  // active → 输入框换绿晕(.pi-composer-goal)。pluginsNonce 键控重订:插件并行加载,
  // timeline 可能先挂载而 goal 的 channel 尚未注册(on 会抛错)——每次插件集合变化
  // 重试订阅,goal 后到也能接上;replayLast 补回订阅前已发出的状态。goal 插件始终
  // 缺席(被禁)则每次重试都落 catch,保持无晕,绝不影响 timeline 自身。
  const [goalActive, setGoalActive] = useState(false);
  useEffect(() => {
    try {
      return ctx.events.on("goal:state", (payload) => {
        setGoalActive((payload as { active?: boolean } | null)?.active === true);
      }, { replayLast: true });
    } catch {
      return;
    }
  }, [ctx.events, pluginsNonce]);

  // 斜杠命令清单 = 内核命令(快照) + 壳插件命令(注册表,机制同 auxParsers)。
  // pluginsNonce 键控重读:插件热装/卸载后清单即时更新;插件命令在发送前被拦截执行,不进内核。
  const allCommands = useMemo((): CommandItem[] => {
    void pluginsNonce; // 仅作失效键:插件热装/卸载后重读注册表(与 useComposerStats 的 nonce 键控同款)
    const pluginCmds: CommandItem[] = getComposerCommands().map((c) => ({
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      source: "plugin",
    }));
    return [...(snapshot?.commands ?? []), ...pluginCmds];
  }, [snapshot?.commands, pluginsNonce]);

  // 排队队列复用 pendingKey 形态(活会话=sessionPath,新会话壳=`new:${cwd}`),切会话互不可见。
  const queueKey = pendingKey;
  const queue = queueKey ? (pendingQueue[queueKey] ?? []) : [];

  // 新评论浮层在 review 侧锚定选区弹出,无需滚动揭示;这里只剩互斥:
  // 浮层开 → 关掉"编辑已有评论"的内联框,同一时刻只许一个编辑器。
  // 附件渲染互斥由贡献方组件内部自管(编辑器/内联编辑都归 review),timeline 不再处理。

  /** 真正走 RPC 的发送序列(偏好回灌/工具过滤/乐观回显/统计)。返回是否成功;
   *  成功时由调用方负责收尾(清输入框/清队列)。 */
  const doSend = useCallback(async (text: string, attSnapshot?: QueuedMessage["attachments"], image?: { src: string; title?: string }): Promise<boolean> => {
    if (!currentCwd) return false;
    // 附件来源:活篮子有货以活篮子为准(排队后用户可能增删评论);
    // 活篮子空了回落入队快照(活篮子被上一次发送消费后,队列里的评论不丢)。
    const src = (matched?.items?.length ?? 0) > 0
      ? matched
      : (attSnapshot ? { ...attSnapshot, sessionKey: curKey } : null);
    const store = useSessionStore.getState();
    // 待发送图:外部传入(表情包直接发送,与发送按钮走同一动作)优先;
    // 否则消费 composer 挂图 ref(表情包"加入输入框"的待发送图)。
    // 发送成功才清挂图 state(失败保留供重试再带);外部传入的图不占该 state。
    const img = image ?? composerImageRef.current;
    try {
      const res = await store.sendMessage(currentCwd, text, {
        sendSuffix: src?.promptFragment || undefined,
        image: img ?? undefined,
      });
      if (!res.ok) {
        showToast(t("timeline.modelApplyFailed", { error: errText(res.error) }));
        return false;
      }
      if (res.toolFilterFlushed) {
        showToast(
          res.toolFilterFlushed.custom
            ? t("timeline.toolsFilterApplied", { count: res.toolFilterFlushed.count })
            : t("timeline.toolsFilterCleared"),
        );
      }
      if (src?.promptFragment) {
        // 发送成功:清挂载(篮子组件随卸载自行收尾,设计 §5.2——不再 invoke review:sent)。
        setAttachments(null);
      }
      if (!image) setPendingImage(null);
      return true;
    } catch (err) {
      console.error("[sessions] 发送失败:", err);
      return false;
    }
  }, [currentCwd, curKey, matched, showToast, t, setPendingImage]);

  /** 队列 flush:streaming 结束(自然完成或用户停止)后,把整队合并成一条发出。
   *  失败时整队标失败保留(用户重试/编辑/取消),不丢用户输入。
   *  互斥:发送中(sendNow/send 的 sendingRef 置位)被调时挂起置 pendingFlush,
   *  由发送方 finally 补 flush——否则 sendNow 的 abort 触发 streaming false 边沿,
   *  flush 会与 sendNow 的 doSend 并发,把同一条发两次。 */
  const pendingFlushRef = useRef(false);
  const flushQueue = useCallback(async (): Promise<void> => {
    if (sendingRef.current) {
      pendingFlushRef.current = true;
      return;
    }
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
  }, [queueKey, currentCwd, pendingQueue, doSend, clearQueue, markQueueFailed, showToast, t]);

  /** 「立即发送」:打断当前生成,只发队列里这一条(其余条目留在队列等轮末 flush)。
   *  失败标该条 failed(flush 被阻塞,用户可编辑/移除/整队重试),不丢用户输入。
   *  abort 内部对 pi 未启动静默;abort 后 streaming 由事件流置 false,发送不依赖它。 */
  const handleSendNow = useCallback(async (item: QueuedMessage): Promise<void> => {
    if (!queueKey || !currentCwd || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await ctx.messaging.abort().catch(() => {});
      const ok = await doSend(item.text, item.attachments);
      if (ok) {
        removeFromQueue(queueKey, item.id);
        showToast(t("timeline.queue.interruptedSent"));
      } else {
        markQueueItemFailed(queueKey, item.id, t("timeline.queue.sendFailed"));
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      // abort 会触发 streaming false 边沿的 flush;发送期间 flush 被 sendingRef 挂起,
      // 在这里补跑(此时本条已移除/标失败,队列状态最新,不会重复发送)。
      if (pendingFlushRef.current) {
        pendingFlushRef.current = false;
        void flushQueue();
      }
    }
  }, [queueKey, currentCwd, ctx, doSend, removeFromQueue, markQueueItemFailed, showToast, flushQueue, t]);

  // streaming 边沿触发 flush:true→false 时(autoRetry 中 streaming 保持 true,不会误 flush)。
  const prevStreamingRef = useRef(streaming);
  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (was && !streaming) void flushQueue();
  }, [streaming, flushQueue]);

  /** 发送动作——发送按钮与表情包(stickers:send 事件)共用的唯一入口。
   *  接受外部文本+图,内部走 streaming 入队 / kernel 复查 / 双击互斥 / doSend,
   *  与「点击发送按钮」完全同一条路径。返回 false = 未即时发出(入队/拦截/失败)。
   *  清输入框只在「发送的是输入框内容」时发生——表情包直接发送不打扰正在草拟的内容。 */
  const sendText = async (text: string, image?: { src: string; title?: string }): Promise<boolean> => {
    const trimmed = text.trim();
    const fromComposer = trimmed === inputRef.current.trim();
    // 壳插件斜杠命令拦截(/goal 等,机制见 packages/react/composer-commands):
    // 命中且被处理 → 吞掉本次发送,文本不进内核。放在入队/streaming 判定之前——
    // 命令是即时状态动作,不入消息队列、不依赖内核可用性。
    if (trimmed.startsWith("/")) {
      const handled = await runComposerCommandIfMatch(trimmed);
      if (handled) {
        if (fromComposer) setInput("");
        return false;
      }
    }
    if ((!trimmed && !hasAttachments) || sendingRef.current) return false;
    if (!currentCwd) { showToast(t("shell.openFolderFirst")); return false; }
    if (kernelAvailable === false) {
      // 复查自愈:用户可能刚在设置页装完内核,装好了就直接放行,不弹过期提示。
      // 复查按当前模型归属内核(选 dsh 查 dsh,选 pi 查 pi)。
      const nowOk = await refreshKernelStatus(currentModel?.kernel);
      if (!nowOk) { showToast(t("shell.kernelRequired")); return false; }
    }
    // streaming 中按发送 = 入队(有无正文都入:纯评论是完整意图,附件快照随项携带,
    // flush 时一并拼入);发的是输入框内容则即时清空。
    if (streaming && queueKey) {
      const snapshot = hasAttachments && matched
        ? { items: matched.items ?? [], promptFragment: matched.promptFragment }
        : undefined;
      enqueueMessage(
        queueKey,
        trimmed,
        snapshot,
        trimmed ? undefined : t("timeline.queue.commentsOnly", { count: matched?.items?.length ?? 0 }),
      );
      if (fromComposer) setInput("");
      showToast(t("timeline.queue.enqueued", { count: queue.length + 1 }));
      return false;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      const ok = await doSend(trimmed, undefined, image);
      if (ok && fromComposer) setInput("");
      return ok;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;

  const send = async (): Promise<void> => {
    await sendText(input.trim());
  };

  // 订阅 stickers 插件的"直接发送"请求:表情包点击发送 = 触发发送按钮同一条发送动作
  // (sendText),streaming 入队 / kernel 复查 / 模型回灌 / 附件图全部与发送按钮一致——
  // 这是「等效点击发送按钮」的落点:表情包不再自己写一份 sendMessage 调用。stickers 是
  // 可选插件——channel 未加载/已禁用时 on() 抛错,try/catch 兑底绝不影响 timeline 自身。
  useEffect(() => {
    try {
      return ctx.events.on("stickers:send", (payload) => {
        const p = payload as { text?: string; image?: { src?: string; title?: string } } | null;
        if (typeof p?.text === "string") {
          void sendTextRef.current(p.text, p.image?.src ? { src: p.image.src, title: p.image.title } : undefined);
        }
      });
    } catch {
      return undefined;
    }
  }, [ctx.events]);

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

  // 输入框只读条:策略槽命中 / 未装内核 / 未选项目,三态共用同一呈现(composerPolicies 既有交互)。
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
          if (retrying && capabilities.piExtension) {
            void ctx.pi.abortRetry();
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
        commands={allCommands}
        currentKernel={capabilities.kernel}
        kernelLocked={capabilities.locked}
        composerStats={composerStatsNodes}
        voice={composerVoiceNode}
        goalActive={goalActive}
      >
        {composerActionButtons}
      </Composer>
    );

  // 空态大 logo 的内核归属(§3.5):三处显标(空态 logo/模型下拉/消息头)读同一个来源,
  // 由当前所选模型的内核决定——改模型即三处同步切换。这里跟 currentModel.kernel 走,
  // 而非 capabilities.kernel(那是「后端进程内核」,选模型尚未发消息时进程可能未起)。
  // currentModel 与 capabilities 都空(无任何模型、无会话进程)时 emptyKernel=null——
  // 内核 = 模型的派生量,没有模型就没有内核,不回落 pi。
  const emptyKernel: KernelId | null = currentModel?.kernel ?? capabilities.kernel ?? null;
  if (!currentCwd || (!switching && !messages.some((m) => m.role === "user"))) {
    return (
    <div className="flex-1 flex flex-col min-h-0 relative" style={AREA_FONT_SIZE_STYLE}>
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          {/* 空态 logo 内核感知(§3.5):随当前所选模型的内核切 ⬡/🐋(emptyKernel)。
              跨内核切换时 pi↔dsh 两个 logo 交叉淡入淡出(AnimatePresence mode=wait):
              旧标淡出 → 新标淡入,只消费 motion token 等价的时长/缓动(200ms / emphasized)。 */}
          {emptyKernel && (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={emptyKernel}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <PluginIcon name={emptyKernel} className="w-40 h-40 md:w-48 md:h-48 text-[var(--color-fg)]" />
            </motion.div>
          </AnimatePresence>
          )}
          {currentCwd ? (
            <motion.div
              key={greetingIdx}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="text-[28px] font-semibold text-[var(--color-fg)] tracking-tight"
            >
              {t(`shell.greeting.${greetingIdx}`)}
            </motion.div>
          ) : (
            <div className="text-center">
              <div className="text-[28px] font-semibold text-[var(--color-fg)] tracking-tight">{t("shell.newChat")}</div>
              <div className="mt-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">
                {t("shell.openFolderFirst")}
              </div>
            </div>
          )}
        </div>
        <ComposerDock>{composerTopNodes}{composer}</ComposerDock>
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
        // Virtuoso 重挂 key:全量消息替换(openSession/resync)即重新初始化——
        // initialTopMostItemIndex 只在挂载时生效一次,重挂让官方机制接管置底
        // (挂载后 rAF 滚动 + list 变化重试 + alignToBottom autoscroll),绕开兜底
        // effect 在"新数据尺寸未测量"时用估算位置滚动、随后被 ResizeObserver
        // 补偿钉在中间位置的错位(打开会话不置底的根因)。流式增量(onEvent)不动
        // key,保持 followOutput/兜底跟随。
        key={`${openNonce}:${syncNonce}`}
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
        rangeChanged={(range) => { visibleRangeRef.current = range; }}
        computeItemKey={(_, m) => m.id ?? String(_)}
        className="scrollbar-hidden"
        itemContent={(index, m) => (
          <div className="w-full max-w-[900px] mx-auto px-5 md:px-8">
            <div className={index === 0 ? "pt-8 pb-3" : "py-3"}>
              <MessageRow message={m} collapseDefault={collapseDefault} bubbleMaxLines={userBubbleMaxLines} currentModel={currentModel} />
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
              {/* 内联编辑已随渲染归位(设计 §5.2):编辑动作在 review 的附件组件内部,不再经 timeline。 */}
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
        {composerTopNodes}
        {queueKey && queue.length > 0 && (
          <QueueBasket
            items={queue}
            visibleCount={5}
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
            onSendNow={(item) => void handleSendNow(item)}
            onClearAll={() => { if (queueKey) clearQueue(queueKey); }}
          />
        )}
        {matched?.items?.length && AttachmentRenderer ? (
          <AttachmentRenderer payload={matched} />
        ) : null}
        {/* 待发送图(表情包"加入输入框"):composer 上方展示,带移除按钮。 */}
        {composerImage && (
          <PendingImageBar image={composerImage} onRemove={() => setPendingImage(null)} />
        )}
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

/** 把 role:image 消息吸附到最近的 user 消息(IM 配图风格:图随用户消息一起显示)。
 *  纯函数在 core/attach-images.ts(可裸单测);乐观期 user 消息已带 __image,
 *  这里只处理重开/文件读回的 role:image 条目。 */

/** 流式占位等待指示:首个增量到达之前按秒走表(§7.6 显式面)。此前该窗口渲染「(空消息)」
 *  文案——发送后先看到一条空消息,观感即"发出去了却没反应/空消息不可接受"(根因:占位
 *  无内容时落了终态空消息文案)。计时锚 = 占位 startedAt(发送时刻);首增量到即被
 *  messageStart 替换,本组件随占位消失。自持 500ms 心跳,只本行重渲,不进 memo 面。 */
function PendingTimer({ startedAt }: { startedAt?: number }): React.ReactNode {
  const { t } = useTranslation();
  const anchorRef = useRef<number>(startedAt ?? Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - anchorRef.current) / 1000)));
    }, 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="text-[var(--color-muted)] text-[length:var(--font-size-sm)] animate-pulse">
      {t("shell.thinking")} {elapsed}s
    </div>
  );
}

// streaming 不进 MessageRow 的 memo 面(根因修复):流式起止翻转曾使全部行 memo 失效、
// 完成态消息 DOM 整体替换、用户文本选区被物理摧毁——review 浮动按钮"什么时候可以"
// 的时序依赖由此而来。常规块管线的流式语义由 message.pending 自持(BlockRenderer 内),
// 全局 streaming 只有整消息渲染器(sub-agent 卡片)需要,拆壳单独订阅。
const MessageRow = memo(function MessageRow({ message, collapseDefault, bubbleMaxLines, currentModel }: { message: NeutralMessage; collapseDefault: boolean; bubbleMaxLines: number; currentModel: ModelInfo | null }): React.ReactNode {
  const { t } = useTranslation();
  // 图:展示元数据由中立层(kernel 版本)合进 messages 的 __image(main 侧 mergeNeutralDisplay),
  // 直接读 __image,不再经 imageIndex(neutral-first §11)。

  // 整消息渲染器优先(messageRenderers 槽,设计 §2.3):命中即整条交给插件,不进块管线。
  const PluginRenderer = getMessageRenderer(message.role);
  if (PluginRenderer) {
    return <SlotRenderedRow renderer={PluginRenderer} message={message} />;
  }

  // 图片消息(custom_message/customType:image 条目):会话流内置展示,不走块管线、
  // 不依赖插件槽。孤立 image 条目(吸附不到 user)直接渲染;正常路径被 attachImagesToUsers
  // 吸附到 user 消息(IM 配图风格),走下方 user 分支的 __image。
  if (message.role === "image") {
    const img = parseImageContent(message.content);
    if (!img) return null;
    return (
      <div className="group" data-message-id={message.id ?? undefined}>
        <ImageBlock src={img.src} />
      </div>
    );
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
    // IM 配图风格:图在用户消息上方。展示元数据经中立层合进 __image(乐观发送或重开读回)。
    const img = (message as NeutralMessage & { __image?: { src: string; title?: string } }).__image;
    return (
      <div className="group" data-message-id={message.id ?? undefined}>
        {img && <ImageBlock src={img.src} />}
        {renderBlocks()}
        <div className="flex items-center gap-2">
          {/* 时间在按钮左侧(朝对话中间靠拢):用户消息靠右,按钮 justify-end,时间占左。 */}
          <MessageMeta message={message} />
          <MessageActions message={message} text={rowText} />
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="group relative" data-message-id={message.id ?? undefined}>
        {/* 行级内核标 + 模型名(§3.5):标识「这条由哪个内核的哪个模型生成」。会话元数据,不走块槽。 */}
        {currentModel && (
          <div className="flex items-center gap-1.5 mb-1 text-[length:var(--font-size-xs)] text-[var(--color-muted)] select-none">
            <PluginIcon name={currentModel.kernel} className="size-3.5 shrink-0" />
            <span className="truncate font-[var(--font-family-mono)]">{currentModel.name || currentModel.id}</span>
          </div>
        )}
        {renderBlocks()}
        {blocks.length === 0 && message.pending === true && (
          <PendingTimer startedAt={message.startedAt} />
        )}
        {blocks.length === 0 && message.pending !== true && !message.error && (
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
        <div className="flex items-center gap-2">
          {rowText && <MessageActions message={message} text={rowText} />}
          {/* 时间在按钮右侧(朝对话中间靠拢):AI 消息靠左,按钮靠左,时间占右。 */}
          <MessageMeta message={message} />
        </div>
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

/** 待发送图条(composer 上方,表情包"加入输入框"的中间态):展示图 + 移除按钮。
 *  图以 dataUri 由贡献方(stickers)读文件提供,timeline 只挂载渲染不碰文件读取。 */
function PendingImageBar({ image, onRemove }: { image: { src: string; title?: string; dataUri?: string }; onRemove: () => void }): React.ReactNode {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)]"
      style={{ width: "fit-content", maxWidth: "100%" }}
    >
      {image.dataUri ? (
        <img src={image.dataUri} alt={image.title ?? "待发送图片"} className="h-16 w-auto max-w-[120px] rounded-[var(--radius-sm)] object-cover" />
      ) : (
        <span className="text-[var(--color-muted)] text-[length:var(--font-size-xs)] truncate max-w-[160px]">{image.src}</span>
      )}
      <span className="flex-1 min-w-0 text-[var(--color-muted)] text-[length:var(--font-size-xs)] truncate max-w-[220px]">
        {image.title ?? "贴纸"}
      </span>
      <button
        type="button"
        onClick={onRemove}
        title="移除图片"
        className="flex items-center justify-center size-6 rounded-full border-none bg-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)] cursor-pointer shrink-0"
      >
        <X className="size-3.5" />
      </button>
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

