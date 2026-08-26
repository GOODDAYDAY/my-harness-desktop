// 会话投影 store(renderer 侧单一真相源)—— main SessionStore 投影的镜像。
//
// 数据流:main 推 session:snapshot(切换时一次基线)+ session:event(持续增量)。
// 本 store 应用增量,组件只读 store、永不各自 getSnapshot(消灭 3× 重复拉取)。
// stats 与 messages/streaming 同级,是会话投影的一个字段,双源(与 messages 同模式):
// 文件聚合基线(openSession 随 detail 到达,打开即有不依赖活进程)+ 活会话 RPC 真值
// (snapshot 到达与轮次结束 messageEnd/agentSettled/agentEnd 由框架统一拉取覆盖)。
// startNewChat/空会话置 null(真未运行)。插件零拉取、零刷新时机、零失效维护
// (此前 timeline/token-stats 各自 useState + getStats + 挑事件刷新,生命周期
// 维护两份且不一致:一个切会话不清零残留旧值,一个自己发明就绪闸。收敛至此,
// 就绪闸/防竞态只有这一份,勿回退到插件侧各自拉取)。
// 模块级单例:首个组件挂载时 init 一次(幂等)。
import { create } from "zustand";
import type { NeutralMessage, SessionDetail, SessionEvent, SyncSnapshot, ModelInfo, SessionState, SessionStats, SessionToolConfig, SessionModelPrefs, SessionInfo, KernelEvent, KernelId } from "@my-harness-desktop/contract";
import { sessionEntryToNeutral, messageContentText as textOf, parseSessionModelPrefs, deriveSessionTitle } from "@my-harness-desktop/contract";
import { useUiStore } from "./ui-store";

// ── 工具限制注入(从 timeline 收编,发送统一入口的构成部分) ──────────────
// 注入文本是发往内核的协议指令(渲染层经 stripToolLimitNote 剥除,用户气泡不可见),
// 非 UI 文案——演进:内核提供工具白名单 RPC 后整体移除(勿 i18n,勿当界面文案改)。
const TOOL_LIMIT_PREFIX = "[System] 本次会话已限制可用工具。";
export function buildToolLimitNote(tools: string[]): string {
  // 空清单 = 全禁(显式语义,不是缺省)——软注入也必须传达"无可用工具"。
  const list = tools.length > 0 ? tools.join(", ") : "无";
  return TOOL_LIMIT_PREFIX + "\n可用工具: " + list + "\n请勿使用未在列表中的工具。";
}
export function stripToolLimitNote(text: string): string {
  if (!text.startsWith(TOOL_LIMIT_PREFIX)) return text;
  const sep = text.indexOf("\n\n");
  return sep >= 0 ? text.slice(sep + 2) : "";
}

/** sendMessage 结果:ok=false 即偏好回灌失败中止(不发送);warning=头对齐失败不中止;
 *  toolFilterFlushed 供调用方弹"工具过滤已应用"提示。 */


export interface SendMessageResult {
  ok: boolean;
  reason?: "modelPrefs";
  error?: string;
  toolFilterFlushed?: { custom: boolean; count: number };
}

/** 从会话文件头读模型/思考强度偏好(冷起纠偏源)。读失败返 null,与 timeline 现状一致。 */
async function readHeaderPrefs(cwd: string, sessionPath: string): Promise<SessionModelPrefs | null> {
  try {
    const list = await window.kernel.sessions.list(cwd);
    const found = list.find((s) => s.path === sessionPath);
    return parseSessionModelPrefs((found?.custom as Record<string, unknown> | undefined) ?? undefined);
  } catch {
    return null;
  }
}

export interface SessionStoreState {
  /** 投影基线(null = pi 未启动/未同步;文件读不产生基线) */
  snapshot: SyncSnapshot | null;
  /** 消息流(文件读基线 或 投影基线 + 事件流)。展示元数据(图)经 main 从中立层
   *  (kernel 版本)合进消息的 __image 字段,不再经 imageIndex(neutral-first §11)。 */
  messages: NeutralMessage[];
  /** 会话统计(token 用量/上下文占用/tps)。双源:文件聚合基线(openSession 随 detail
   *  到达,打开即有)+ 活会话 RPC 真值(snapshot/轮次结束覆盖,带 tps/权威 contextUsage)。
   *  null = 未运行(新会话/空会话文件)。 */
  stats: SessionStats | null;
  /** 当前模型可用的思考档位清单(内核 get_available_thinking_levels;随模型变)。
   *  [] = 未运行(新会话/文件读历史会话),消费方按展示策略兜底。
   *  生命周期随投影基线:openSession/startNewChat 置 [],snapshot/modelSelect 框架刷新。 */
  thinkingLevels: string[];
  /** 当前会话后端的扩展能力面 + 内核归属(main 侧 capabilities 投影;piExtension=false 时
   *  steer/followUp/thinkingLevel/队列/导出等 pi 专属入口置灰,§7.6 显式降级;
   *  kernel/locked 供内核 TAB 置灰:locked 且非 kernel 的 TAB 不可切)。 */
  capabilities: { kernel: KernelId | null; locked: boolean; piExtension: boolean; dshExtension: boolean };
  streaming: boolean;
  /** 切换会话中(乐观 UI:骨架/旧内容淡出) */
  switching: boolean;
  /** 快照代际:onSnapshot 每次递增。消费方(timeline)依赖它重置滚动位置——
   *  resync 不经 switching(openSession 才设 switching),只有 syncNonce 能捕获 resync 后的消息替换。 */
  syncNonce: number;
  /** 会话打开代际:openSession 成功读文件基线后递增。与 syncNonce 成对——
   *  syncNonce 捕获 resync 的全量替换,openNonce 捕获 openSession 的全量替换。
   *  消费方(timeline)用两者做 Virtuoso 重挂 key:全量替换即重新初始化,由官方
   *  initialTopMostItemIndex 置底,不依赖兜底 effect 在尺寸未测准时的估算滚动。 */
  openNonce: number;
  /** 可展示(有消息基线,不论来自文件还是 pi) */
  ready: boolean;
  /** 发送序号:sendMessage 成功后递增。timeline 订阅它做"发送后滚底清未读"——
   *  所有发送入口(composer/rewind/notes)的行为由构造强制一致,入口无需自己收尾。 */
  lastSendNonce: number;
  /** 当前 cwd 的会话元数据 map(框架统一拉取/事件维护;消费方只读订阅)。
   *  null = 未拉取;消费方(sessions-list/session-colors/timeline)不再各自 ctx.sessions.list。 */
  sessionInfos: Record<string, SessionInfo> | null;
  /** sessionInfos 对应的 cwd(防竞态:切 cwd 后旧响应丢弃)。 */
  sessionInfosCwd: string | null;
  /** 框架唯一拉取口:拉 currentCwd 的会话列表进 sessionInfos。切 cwd 与 kernel 事件流触发。 */
  loadSessionInfos: (cwd: string) => Promise<void>;
  /** 打开历史会话:纯文件读,秒开,不启 pi。
   *  返回 false = 文件缺失/不可读(静默放弃,不进空会话、不 setContext——
   *  cwd 落空的防护语义不变,只是不再以异常噪音上报,由调用方决定如何呈现)。 */
  openSession: (sessionPath: string) => Promise<boolean>;
  /** 新会话:本地清空,零 RPC;进程在首次发送时按需起。 */
  startNewChat: (cwd: string) => Promise<void>;
  /** 用户发消息后乐观回显(等 messageEnd(user) 到了去重) */
  appendOptimisticUser: (text: string, sendText: string) => void;
  /** 发送同时创建 assistant 占位(pending:true,content:'')消除空窗。
   *  pi 推 messageStart 时按 id 替换占位,messageUpdate 持续 patch。 */
  appendPendingAssistant: () => void;
  /** "发一条用户消息"的唯一受管写口(CLAUDE.md §3.3 收敛:composer/rewind/notes
   *  曾各自复制发送序列,notes 因此丢了偏好回灌/工具过滤,行为与发送按钮不一致)。
   *  完整序列:无会话先 startNewChat → 模型/思考强度对齐(pending 回灌 + 头对齐,
   *  失败中止不发送)→ 工具过滤生效(读生效 toolConfig,custom 且未装 tool-gate 时
   *  注入限制说明)→ 乐观回显 → assistant 占位 → RPC 发送 → bump lastSendNonce。
   *  插件不直改 store(§8.2 只读纪律),发送意图只经此动作表达;所有入口行为由构造一致。
   *
   *  ── 水合契约(勿回退/勿删,2025-11 根因修复) ──
   *  currentSessionPath 的水合规则两层不冲突,删除任一层都会引入回归:
   *  1) 渲染层「乐观设置」:sessions-list.select() 点击瞬间同步写 useUiStore.currentSessionPath
   *     (高亮需要同步性,async IPC 事件有毫秒级差,不等)[见 sessions-list/renderer/index.tsx select()]
   *  2) main 层「权威确认」:SessionStore.setContext/prompt 发完后 dispatch synthetic sessionStart
   *     (内核 session_start 是纯扩展事件,永到不了 RPC stdout → renderer 永远等不到内核推
   *     该事件,真相源单一在 main,见 src/core/application/sessions/session-store.ts 两处注释)
   *  两层不冲突:乐观层管高亮即时性,权威层管最终一致性。
   *  勿删任何一层;官方修复见 src/core/application/sessions/session-store.ts 两处注释 */
   sendMessage: (cwd: string, text: string, opts?: { sendSuffix?: string; image?: { src: string; title?: string } }) => Promise<SendMessageResult>;
}

function patchStateFromEvent(state: SessionState, event: SessionEvent): SessionState | null {
  switch (event.type) {
    case "modelSelect":
      return event.model ? { ...state, model: event.model as ModelInfo } : null;
    case "thinkingLevelChanged":
    case "thinkingLevelSelect": {
      const level = (event as { thinkingLevel?: string }).thinkingLevel;
      return level ? { ...state, thinkingLevel: level } : null;
    }
    case "agentStart":
      return { ...state, isStreaming: true };
    case "agentSettled":
    case "agentEnd":
      return { ...state, isStreaming: false };
    // auto-retry 退避等待期(上轮 agent_end 之后、下轮 agent_start 之前)视作流式中:
    // 重试视作"模型仍在工作",停止按钮/输入禁用等 streaming 派生行为保持一致。
    case "autoRetryStart":
      return { ...state, isStreaming: true };
    case "autoRetryEnd":
      // success=true:恢复生成,streaming 应由下一轮事件/快照自然推进,此处不改;
      // success=false/缺席:重试序列终结,关闭流式标记。
      return (event as { success?: boolean }).success === true ? null : { ...state, isStreaming: false };
    case "compactionStart":
      return { ...state, isCompacting: true };
    case "compactionEnd":
      return { ...state, isCompacting: false };
    case "sessionStart": {
      const sf = (event as { sessionFile?: string }).sessionFile;
      return sf ? { ...state, sessionFile: sf } : null;
    }
    case "sessionInfoChanged": {
      const name = (event as { sessionName?: string }).sessionName;
      return name ? { ...state, sessionName: name } : null;
    }
    case "queueUpdate": {
      const count = (event as { pendingMessageCount?: number }).pendingMessageCount;
      return count != null ? { ...state, pendingMessageCount: count } : null;
    }
    default:
      return null;
  }
}

/** 流式 message 事件(Start/Update/End)的计时归一。
 *  内核事件 message.timestamp = LLM 调用开始时间(实测实证:assistant 的 msgTs ≈ 用户发送时刻,
 *  entry 级 timestamp 才是落盘/完成时间——两者差即一轮调用真实耗时)。
 *  圆心语义 timestamp=完成时间——流式期间完成时间未知,把开始时间挪进 startedAt、清掉 timestamp,
 *  权威完成时间由 entryAppended 落盘回执在水合时补(见下方水合分支)。
 *  注意:startedAt 可能仍为 undefined(内核事件缺 timestamp 的极端路径),消费方须兜底。 */
function withStreamTiming(msg: NeutralMessage): NeutralMessage {
  const startedAt = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(msg as Record<string, unknown>)) {
    if (k !== "timestamp") rest[k] = v;
  }
  return { ...rest, startedAt, timestamp: undefined } as unknown as NeutralMessage;
}

/** 事件增量应用(纯函数,便于测试)。
 *  按 messageId 精确 patch(L1.5 范式),不靠末条 role 替换。
 *  messageUpdate/messageEnd 的 event.message 带 id → find-by-id patch;
 *  找不到(id 不匹配,如 pi 直接推 messageUpdate 没经占位)→ 追加。
 *
 *  pending 生命周期(单一语义:"该消息流式进行中",渲染层依此挂流式光标):
 *  置 true:占位(appendPendingAssistant)、messageStart、messageUpdate;
 *  清 false:仅 messageEnd(终态,含 abort/失败收尾)。
 *  messageUpdate 绝不清 pending——此前 find-by-id / 末条替换两分支写死 pending:false,
 *  导致流式消息收到第一条 update 后就丢标记,渲染层被迫用全局 streaming 广播兜底,
 *  所有历史 assistant 消息在流式期间被误挂光标(根因修复,勿回退)。 */
export function applyEvent(messages: NeutralMessage[], event: SessionEvent): NeutralMessage[] {
  const rawMsg = (event as { message?: NeutralMessage }).message;
  // 流式 message 事件入口统一计时归一(见 withStreamTiming 注释):
  // 各分支的 ...msg 展开自动带上 startedAt、timestamp 已清,不重复手写。
  const msg = rawMsg && (event.type === "messageStart" || event.type === "messageUpdate" || event.type === "messageEnd")
    ? withStreamTiming(rawMsg)
    : rawMsg;
  if (event.type === "messageUpdate" && msg) {
    if (msg.id) {
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) return messages.map((m, i) => i === idx ? { ...m, ...msg, startedAt: msg.startedAt ?? m.startedAt, timestamp: msg.timestamp ?? m.timestamp, pending: true } : m);
    }
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") return [...messages.slice(0, -1), { ...msg, pending: true }];
    return [...messages, { ...msg, pending: true }];
  }
  if (event.type === "messageStart" && msg) {
    if (msg.role === "user") {
      const text = textOf(msg.content);
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        // 匹配键双轨(根因修复,勿回退):echo/send 双形态下(工具前缀)乐观回显
        // 与实发文本不同,仅按全文匹配必失配——内核回放被当成新消息追加,时间线双条。
        // __sendText 是发送时随乐观消息携带的实发全文,与回放全文精确对齐。
        // 命中后保留乐观消息的正文(content),只吸收回放权威字段。
        if (m.role === "user" && m.__optimistic === true
          && (textOf(m.content) === text || m.__sendText === text)) {
          return messages.map((x, idx) => idx === i
            ? { ...x, ...msg, content: x.content, pending: true, __optimistic: true }
            : x);
        }
      }
    }
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && (last.pending || last.content === "" || last.content === undefined)) {
      return [...messages.slice(0, -1), { ...msg, pending: true }];
    }
    return [...messages, { ...msg, pending: true }];
  }
  if (event.type === "messageEnd" && msg) {
    if (msg.id) {
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) return messages.map((m, i) => i === idx ? { ...msg, startedAt: msg.startedAt ?? m.startedAt, timestamp: msg.timestamp ?? m.timestamp, pending: false, stopped: false } : m);
    }
    const last = messages[messages.length - 1];
    // 只替换「流式占位」(pending / 空内容),不替换已完成消息——dsh 一轮内每个 step 各推
    // 一条完整的 assistant/message(→ messageEnd),若按「同 role 覆盖末条」处理,step2 会
    // 盖掉 step1 的思考链+工具卡,只剩末条文本,会话流丢失整个处理过程(根因)。
    if (last && last.role === msg.role && (last.pending === true || last.content === "" || last.content === undefined)) {
      return [...messages.slice(0, -1), { ...msg, pending: false }];
    }
    if (msg.role === "user") {
      const text = textOf(msg.content);
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        // 同 messageStart 的 user 分支:__sendText 双轨匹配,命中保留正文并转正。
        if (m.role === "user" && m.__optimistic === true
          && (textOf(m.content) === text || m.__sendText === text)) {
          return messages.map((x, idx) => idx === i
            ? { ...x, ...msg, content: x.content, __optimistic: false }
            : x);
        }
      }
    }
    return [...messages, msg];
  }
  if (event.type === "toolCallEnd") {
    const toolCallId = String((event as { toolCallId?: unknown }).toolCallId ?? "");
    if (!toolCallId) return messages;
    const result = (event as { result?: unknown }).result;
    const isError = (event as { isError?: boolean }).isError === true;
    // dsh 的工具结果经独立 tool/result 事件到达(pi 经 messageUpdate 把 result 流进内容块),
    // 而工具卡渲染读的是 assistant 消息内容块的 toolCall.result——按 toolCallId 回填到
    // 最近一条含该 toolCall 块的消息;找不到则 no-op(pi 已在内容块里,不重复写)。
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!Array.isArray(m.content)) continue;
      let patched = false;
      const content = m.content.map((block) => {
        if (typeof block !== "object" || block === null) return block;
        const b = block as Record<string, unknown>;
        if (b.type === "toolCall" && b.id === toolCallId) {
          patched = true;
          return { ...b, result, isError };
        }
        return block;
      });
      if (patched) return messages.map((x, idx) => (idx === i ? { ...x, content } : x));
    }
    return messages;
  }
  if (event.type === "entryAppended") {
    const entry = (event as { entry?: unknown }).entry;
    if (!entry) return messages;
    const neutral = sessionEntryToNeutral(entry);
    if (!neutral) return messages;
    if ((entry as { type?: string }).type === "message") {
      // 消息条目落盘回执:消息体已由 messageStart/Update/End 渲染(内核 AgentMessage 无 id 字段),
      // 这里只做 id 水合——把权威 entryId 补到已渲染消息上(书签/fork/patch 的锚点)。
      // 匹配两段制(终态契约,勿回退):
      //   ① 严格:倒序取最近一条同 role 且全文相等——正常流零漂移;重发/同文本消息不误绑旧位置。
      //   ② 位置兜底:全文失配时(echo 注入前缀、stopped 截断、错误消息落盘差异),取最早未水合
      //     的同 role 可锚消息——entries 与可视消息都按 FIFO 追加序产生,先到先得一一对齐;
      //     早先失配滞留的消息也随后续 entry 顺序自愈。
      //   水合即转正(清 __optimistic 标记):已转正消息不再参与锚定,后续同 role entry
      //   不会误绑旧档(不清理则下一条同 role entry 会反复改绑同一条)。
      //   两阶段都失败:console.warn 显形(锚点丢失无声 = 收藏按钮消失无人知,见 P-锚点评估)。
      if (!neutral.id) return messages;
      const text = textOf(neutral.content);
      const anchorable = (m: NeutralMessage): boolean =>
        m.id == null || m.__optimistic === true;
      const hydrate = (x: NeutralMessage): NeutralMessage =>
        x.__optimistic === true
          ? { ...x, id: neutral.id, __optimistic: false, startedAt: neutral.startedAt ?? x.startedAt, timestamp: neutral.timestamp }
          : { ...x, id: neutral.id, startedAt: neutral.startedAt ?? x.startedAt, timestamp: neutral.timestamp };
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        // __sendText 双轨:echo/send 双形态下全文失配是常态,实发全文才是与落盘 entry 的对齐键
        if (m.role === neutral.role && anchorable(m)
          && (textOf(m.content) === text || m.__sendText === text)) {
          return messages.map((x, idx) => (idx === i ? hydrate(x) : x));
        }
      }
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === neutral.role && anchorable(m)) {
          return messages.map((x, idx) => (idx === i ? hydrate(x) : x));
        }
      }
      console.warn(`[session-store] entryAppended 水合失败:找不到可锚定的 ${neutral.role} 消息(id=${neutral.id}),收藏/回退锚点未建立`);
      return messages;
    }
    // 非消息条目(分隔线/custom 消息)按身份去重(防内核重复推送同一 entry)。
    // divider 的 content 恒为 ""(session-state.ts:372),不可用 textOf(content) 判重——
    // 否则任意两条 divider 互判重复,model/thinking 分隔线全被吞(根因)。
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== neutral.role) continue;
      if (m.role === "divider") {
        // 两条都有 id 按 id 判重;否则回退 kind+i18nKey+i18nArgs(内核条目恒带 id)。
        if (neutral.id && m.id) { if (m.id === neutral.id) return messages; continue; }
        if (m.kind === neutral.kind && m.i18nKey === neutral.i18nKey
          && JSON.stringify(m.i18nArgs) === JSON.stringify(neutral.i18nArgs)) return messages;
      } else if (textOf(m.content) === textOf(neutral.content)) {
        return messages;
      }
    }
    return [...messages, neutral];
  }
  return messages;
}

/** 投影拉取防竞态代际:基线替换(openSession/startNewChat)时递增,
 *  在飞的旧 RPC 回来后比对不一致即丢弃(切会话后旧会话的值不写回)。 */
let sessionGen = 0;

/** stats 框架唯一拉取口:快照到达/轮次起止时调(agentStart 是翻轮点——main 在那一刻
 *  归档 lastTurn 并清零 turn,不拉则翻轮后旧值停留到首个 messageEnd)。
 *  就绪闸天然成立——这几类时机都意味着 pi 活着;新会话/文件读根本走不到这里。 */
function refreshStats(): void {
  const gen = sessionGen;
  void window.kernel.sessions.getStats()
    .then((s) => { if (gen === sessionGen) useSessionStore.setState({ stats: s as SessionStats }); })
    .catch(() => { /* pi 中途退出:保持现状,下轮事件再试 */ });
}

/** thinkingLevels 框架唯一拉取口:快照到达/模型切换时调(档位清单随模型变)。
 *  thinkingLevels 是 pi 专属能力(§7.6):非 pi 内核不拉取——避免静默发一个
 *  注定抛「不支持 pi 专属命令」的 RPC。空清单不覆盖——内核异常回空时保持现值,
 *  与 stats 的 catch 兜底同语义。 */
function refreshThinkingLevels(): void {
  if (!useSessionStore.getState().capabilities.piExtension) return;
  const gen = sessionGen;
  void window.kernel.sessions.pi.getThinkingLevels()
    .then((ls) => { if (gen === sessionGen && ls.length > 0) useSessionStore.setState({ thinkingLevels: ls }); })
    .catch(() => { /* pi 中途退出:保持现状,下次快照/切模型再试 */ });
}

/** 当前会话扩展能力面拉取(main 侧 capabilities 投影;内核切换/启动时调)。 */
function refreshCapabilities(): void {
  void window.kernel.sessions.getCapabilities()
    .then((c) => useSessionStore.setState({ capabilities: c }))
    .catch(() => { /* main 未就绪等;下次内核事件再刷 */ });
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  snapshot: null,
  messages: [],
  stats: null,
  thinkingLevels: [],
  capabilities: { kernel: null, locked: false, piExtension: false, dshExtension: false },
  streaming: false,
  switching: false,
  syncNonce: 0,
  openNonce: 0,
  ready: false,
  lastSendNonce: 0,
  sessionInfos: null,
  sessionInfosCwd: null,
  loadSessionInfos: async (cwd) => {
    if (!cwd) return;
    try {
      const list = (await window.kernel.sessions.list(cwd)) as SessionInfo[];
      // 防竞态:拉取期间切了 cwd,旧响应丢弃
      if (useUiStore.getState().currentCwd !== cwd) return;
      const map: Record<string, SessionInfo> = {};
      for (const s of list) {
        map[s.path] = s;
        // §kernel-forkless §32 主键迁移过渡:双键(path 保留 + neutralSessionId 候选)。
        // 有 neutralSessionId 的会话按 neutral id 也能查到,消费方可渐进迁移、path 不再唯一。
        if (s.neutralSessionId) map[s.neutralSessionId] = s;
      }
      useSessionStore.setState({ sessionInfos: map, sessionInfosCwd: cwd });
    } catch {
      // 拉取失败保持旧值(切 cwd 瞬间 main 未就绪等);下次触发重试
    }
  },
  openSession: async (id) => {
    sessionGen++;
    set({ switching: true });
    try {
      const detail = (await window.kernel.sessions.openSession(id)) as SessionDetail | null;
      // 文件缺失/损坏:静默放弃(评估 M-5 的 cwd 落空防护保留——不进空会话、不 setContext),
      // 不以异常上报;初始/外部删除场景不应向用户抛错。
      if (!detail) {
        console.warn(`[session-store] 会话不可读,放弃打开: ${id}`);
        set({ switching: false });
        return false;
      }
      // 文件读即基线(秒开);同时记录发送上下文(cwd 取文件 header 的,最准)
      await window.kernel.sessions.setContext(detail.info.cwd, detail.info.path);
      // 显式设置 currentSessionPath(不依赖 sessionStart 事件的异步水合)
      useUiStore.getState().setCurrentSessionPath(detail.info.path);
      useUiStore.getState().setCurrentNeutralSessionId(detail.info.neutralSessionId ?? null);
      set((s) => ({
        messages: detail.messages,
        snapshot: null,
        // 文件聚合基线:打开即有,不依赖活进程;活会话 snapshot/RPC 真值到达后覆盖
        stats: detail.stats,
        thinkingLevels: [],
        streaming: false,
        switching: false,
        ready: true,
        // 打开代际递增:timeline 用它触发 Virtuoso 重挂,全量替换重新初始化置底
        openNonce: s.openNonce + 1,
      }));
      // 权威层(设计 docs/design/plugin-decoupling.md §4.3):currentSessionPath 的乐观层
      // 在调用方(水合契约两层中的渲染层),main 已经 dispatch sessionStart 做权威确认;
      // sessionTitle 此前只有乐观层没有权威层——会话在后台被改名后 ui-store.title stale。
      // 这里用读到的详情 derive 补权威层(幂等:与乐观层同值)。
      const ui = useUiStore.getState();
      if (ui.currentSessionPath !== detail.info.path) ui.setCurrentSessionPath(detail.info.path);
      if (ui.currentNeutralSessionId !== (detail.info.neutralSessionId ?? null)) ui.setCurrentNeutralSessionId(detail.info.neutralSessionId ?? null);
      ui.setSessionTitle(deriveSessionTitle(detail.info));
      return true;
    } catch (err) {
      set({ switching: false });
      throw err;
    }
  },
  startNewChat: async (cwd) => {
    sessionGen++;
    await window.kernel.sessions.setContext(cwd, null);
    set({ messages: [], snapshot: null, stats: null, thinkingLevels: [], streaming: false, switching: false, ready: true });
  },
  appendOptimisticUser: (text, sendText) => {
    set((s) => ({ messages: [...s.messages, {
      id: crypto.randomUUID(), role: "user", content: text,
      __sendText: sendText, __optimistic: true,
    }] }));
  },
  appendPendingAssistant: () => {
    set((s) => ({ messages: [...s.messages, { id: crypto.randomUUID(), role: "assistant", content: "", pending: true }] }));
  },
  sendMessage: async (cwd, text, opts) => {
    const ui = useUiStore.getState();
    const pendingKey = ui.currentSessionPath ?? (cwd ? `new:${cwd}` : null);
    const pending = pendingKey ? ui.sessionModelPending[pendingKey] : undefined;

    // §atomic-send:三级来源(pending > 头 > fallback)拼一个 SessionModelPrefs,一次传给 main。
    // 差异执行 + 双写 + 发消息收进 SessionStore.prompt 编排,renderer 不再逐条 RPC。
    let prefs: SessionModelPrefs | undefined;
    if (pending) {
      prefs = pending;
    } else if (ui.currentSessionPath) {
      prefs = (await readHeaderPrefs(cwd, ui.currentSessionPath)) ?? undefined;
    } else {
      // 新会话且无 pending:显式对齐默认/首项模型(根因同旧注释,勿回退)。
      try {
        const model = await window.kernel.models.getFallbackModel();
        if (model) {
          prefs = { provider: model.provider, modelId: model.model, thinkingLevel: "", kernel: model.kernel };
        }
      } catch (err) {
        return { ok: false, reason: "modelPrefs", error: err instanceof Error ? err.message : String(err) };
      }
    }

    let finalText = text;
    let toolFilterFlushed: { custom: boolean; count: number } | undefined;
    const sessionPath = ui.currentSessionPath;
    if (sessionPath) {
      try {
        const pendingTools = ui.pendingToolConfig?.sessionPath === sessionPath ? ui.pendingToolConfig : null;
        let toolCfg: SessionToolConfig | null;
        if (pendingTools && !pendingTools.flushed) {
          await window.kernel.sessions.updateHeader(sessionPath, { toolConfig: pendingTools.config });
          ui.setPendingToolConfig({ ...pendingTools, flushed: true });
          toolCfg = pendingTools.config;
          toolFilterFlushed = { custom: toolCfg != null, count: toolCfg?.enabledToolIds?.length ?? 0 };
        } else {
          toolCfg = await window.kernel.sessions.readToolConfig(sessionPath);
        }
        if (toolCfg && Array.isArray(toolCfg.enabledToolIds)) {
          const enabledTools = toolCfg.enabledToolIds;
          const gateInstalled = await window.kernel.kernels.pi.fitPiExtensionAvailable?.().catch(() => false);
          if (!gateInstalled) {
            finalText = `${buildToolLimitNote(enabledTools)}\n\n${text}`;
          }
        }
      } catch { /* 工具配置读取失败则不加限制,照常发送 */ }
    }

    if (!useUiStore.getState().currentSessionPath) {
      await get().startNewChat(cwd);
    }
    // filter-join 拼装:正文可空(纯附件发送)时不留前导换行
    const sendText = [finalText, opts?.sendSuffix].filter(Boolean).join("\n");
    // 乐观 content 直接放全文(含 sendSuffix 拼装块):乐观态/水合态/落盘态/重开态
    // 用同一条数据,发送当轮即解析出引用条——content 是唯一真相源(设计 §5)。
    // __sendText 保持全文不变,作内核回放/落盘 entry 水合的匹配键(双轨第二轨冗余,演进)。
    get().appendOptimisticUser(sendText, sendText);
    // 图:展示元数据(交流机制,不是 AI 输入)——乐观 __image 即时显示 + 经 prompt 传给
    // main 写进中立层(kernel 版本),不再写 imageIndex/session-images.json(neutral-first §4)。
    const imageOpt = opts?.image;
    if (imageOpt) {
      const { src, title } = imageOpt;
      const cur = get();
      set({
        messages: cur.messages.map((m, i) =>
          i === cur.messages.length - 1 && m.role === "user" ? { ...m, __image: { src, title } } : m),
      });
    }
    get().appendPendingAssistant();
    // §atomic-send:一次 prompt 带全参(回灌 + 发送)。失败统一中止——
    // 回灌失败=这次发送的模型/强度不确定,不伪造成功(旧实现 headerPrefs 失败 warning 不中止,
    // 会「用进程当前模型发但用户以为用头记模型」——改为诚实中止)。
    try {
      await window.kernel.sessions.prompt(
        sendText,
        undefined,
        imageOpt ? { image: { src: imageOpt.src, title: imageOpt.title } } : undefined,
        prefs,
      );
    } catch (err) {
      return { ok: false, reason: "modelPrefs", error: err instanceof Error ? err.message : String(err) };
    }
    // 执行成功才消费意图(session-model-config.md §4.1):pending 保留到此刻,失败不吞。
    if (pending && pendingKey) {
      ui.clearSessionModelPending(pendingKey);
    }
    set((s) => ({ lastSendNonce: s.lastSendNonce + 1 }));
    return { ok: true, toolFilterFlushed };
  },
}));
let inited = false;

/** 快照应用(纯函数,可裸单测):空快照(新会话 warmup 的 start sync,内核尚未处理 prompt)
 *  不得冲掉乐观消息——否则首条消息的乐观回显被清、entryAppended 水合找不到锚、首图丢失。
 *  此时基线(snapshot)照常更新,但 messages 保留、syncNonce 不递增(无全量替换)。
 *  非空快照 = 权威全量替换:照常清旧消息、递增 syncNonce 触发 Virtuoso 重挂。 */
export function applySnapshot(s: SessionStoreState, snapshot: SyncSnapshot): Partial<SessionStoreState> {
  const msgs = snapshot.messages ?? [];
  const streaming = snapshot.state?.isStreaming ?? false;
  const hasOptimistic = s.messages.some((m) => m.__optimistic === true || m.pending === true);
  // 快照只有 meta 条目(divider 等,无 user/assistant 内容)时不冲掉乐观消息——
  // pi 起进程即 sync,快照带着 model_change/thinking_level_change 两条初始化 divider,
  // 若视为权威全量替换,首条消息的乐观回显会被这俩 divider 顶掉(发送后立即消失)。
  const hasContent = msgs.some((m) => m.role === "user" || m.role === "assistant");
  if ((msgs.length === 0 || !hasContent) && hasOptimistic) {
    return { snapshot, streaming, switching: false, ready: true };
  }
  return {
    snapshot,
    // 内核快照是投影基线(权威);展示元数据(图)由中立层(kernel 版本)合进 messages 的 __image,不受快照影响。
    messages: msgs,
    streaming,
    switching: false,
    syncNonce: s.syncNonce + 1,
    ready: true,
  };
}

/** 初始化 main→renderer 通道(幂等;应用启动时调一次)。 */
export function initSessionStore(): void {
  if (inited) return;
  inited = true;

  window.kernel.sessions.onSnapshot((snapshotRaw) => {
    const snapshot = snapshotRaw as SyncSnapshot;
    useSessionStore.setState((s) => applySnapshot(s, snapshot));
    refreshStats();
    refreshThinkingLevels();
  });

  // ── sessionInfos 框架统一维护(设计 docs/design/plugin-decoupling.md §4.2)──
  // 切 cwd 拉基线;kernel 事件流命中"影响列表的事件"时重拉(与 sessions-list 旧 reload
  // 条件一致:sessionStart 新文件/messageStart 自动命名/messageEnd 定稿/agentSettled 轮结束)。
  // 消费方(sessions-list/session-colors/timeline)只读 store,不再各自 ctx.sessions.list。
  const loadForCwd = (): void => {
    const cwd = useUiStore.getState().currentCwd;
    if (cwd) void useSessionStore.getState().loadSessionInfos(cwd);
  };
  // ui-store 无 subscribeWithSelector,手动比对 currentCwd 变化(仅变化时拉)。
  let lastCwd = useUiStore.getState().currentCwd;
  const unsubCwd = useUiStore.subscribe((state) => {
    if (state.currentCwd !== lastCwd) {
      lastCwd = state.currentCwd;
      loadForCwd();
    }
  });
  loadForCwd(); // 初始拉一次(挂载晚于 ui-store 初始化)
  refreshCapabilities(); // 初始能力面(main 启动即 pi,后续 kernelChanged 刷新)
  const offKernel = window.kernel.sessions.onKernelEvent((raw) => {
    const evt = raw as KernelEvent;
    if (evt.kind === "kernelChanged") {
      // 跨内核切换完成:刷新能力面 + 快照基线 + 会话列表,驱动三处内核标跟着切(§9.3)。
      refreshCapabilities();
      void window.kernel.sessions.sync().catch(() => {});
      loadForCwd();
      return;
    }
    if (evt.kind !== "session") return;
    const t = evt.event.type;
    if (t === "sessionStart" || t === "messageStart" || t === "messageEnd" || t === "agentSettled") {
      loadForCwd();
    }
  });
  // 模块级单例:进程内不复用卸载清理(与 onSnapshot 同生命周期,应用关才拆)。
  void unsubCwd; void offKernel;

  // session:event 只含激活会话(main dispatch 已按 activeProcKey 过滤),
  // 后台会话的定稿/轮结束/新文件事件不会进这里——不必再担心视图被别的会话污染。
  window.kernel.sessions.onEvent((eventRaw) => {
    const event = eventRaw as SessionEvent;
    if (event.type === "sessionStart") {
      const sf = event.sessionFile;
      if (typeof sf === "string" && sf) {
        useUiStore.getState().setCurrentSessionPath(sf);
        useUiStore.getState().setCurrentNeutralSessionId(useSessionStore.getState().sessionInfos?.[sf]?.neutralSessionId ?? null);
      }
    }
    if (event.type === "compactionEnd") {
      void window.kernel.sessions.sync();
    }
    if (event.type === "messageEnd" || event.type === "agentSettled" || event.type === "agentEnd" || event.type === "agentStart") {
      refreshStats();
    }
    if (event.type === "modelSelect") {
      refreshThinkingLevels();
    }
    useSessionStore.setState((s) => {
      const patched = s.snapshot ? patchStateFromEvent(s.snapshot.state, event) : null;
      const streaming =
        event.type === "agentStart" ? true
        : event.type === "agentSettled" || event.type === "agentEnd" ? false
        : event.type === "autoRetryStart" ? true
        // success=true:恢复生成,streaming 交由后续事件推进;其余:重试终结,关闭。
        : event.type === "autoRetryEnd" && (event as { success?: boolean }).success !== true ? false
        : s.streaming;
      return {
        messages: applyEvent(s.messages, event),
        streaming,
        snapshot: patched ? { ...s.snapshot!, state: patched } : s.snapshot,
      };
    });
  });
}
