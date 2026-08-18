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
import type { NeutralMessage, SessionDetail, SessionEvent, SyncSnapshot, ModelInfo, SessionState, SessionStats, SessionToolConfig, SessionModelPrefs, ModelsConfig, SessionInfo, KernelEvent } from "@my-harness-desktop/contract";
import { sessionEntryToNeutral, messageContentText as textOf, contentHashOf, parseSessionModelPrefs, firstModelOf, deriveSessionTitle } from "@my-harness-desktop/contract";
import { parseImageContent } from "../../../plugins/sessions/timeline/core/attach-images";
import { useUiStore } from "./ui-store";

// ── 工具限制注入(从 timeline 收编,发送统一入口的构成部分) ──────────────
// 注入文本是发往底座的协议指令(渲染层经 stripToolLimitNote 剥除,用户气泡不可见),
// 非 UI 文案——演进:底座提供工具白名单 RPC 后整体移除(勿 i18n,勿当界面文案改)。
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
  warning?: "headerPrefs";
  error?: string;
  toolFilterFlushed?: { custom: boolean; count: number };
}

/** 从会话文件头读模型/思考强度偏好(冷起纠偏源)。读失败返 null,与 timeline 现状一致。 */
async function readHeaderPrefs(cwd: string, sessionPath: string): Promise<SessionModelPrefs | null> {
  try {
    const list = await window.pi.sessions.list(cwd);
    const found = list.find((s) => s.path === sessionPath);
    return parseSessionModelPrefs((found?.custom as Record<string, unknown> | undefined) ?? undefined);
  } catch {
    return null;
  }
}

export interface SessionStoreState {
  /** 投影基线(null = pi 未启动/未同步;文件读不产生基线) */
  snapshot: SyncSnapshot | null;
  /** 消息流(文件读基线 或 投影基线 + 事件流) */
  messages: NeutralMessage[];
  /** 桌面自持图存储:会话路径 → 锚(entryId 或 sendText hash) → 图。图片是桌面附加数据,
   *  写桌面自己的 session-images.json,不 append custom_message 到底座文件(底座不感知、
   *  sync 快照会冲掉)。展示独立于底座快照:发送时乐观写(sendText hash 临时锚)、
   *  entryAppended 水合出 entryId 后升级为 id 锚、openSession 从存量 role:image 建锚。 */
  imageIndex: Record<string, Record<string, { src: string; title?: string }>>;
  /** 会话统计(token 用量/上下文占用/tps)。双源:文件聚合基线(openSession 随 detail
   *  到达,打开即有)+ 活会话 RPC 真值(snapshot/轮次结束覆盖,带 tps/权威 contextUsage)。
   *  null = 未运行(新会话/空会话文件)。 */
  stats: SessionStats | null;
  /** 当前模型可用的思考档位清单(底座 get_available_thinking_levels;随模型变)。
   *  [] = 未运行(新会话/文件读历史会话),消费方按展示策略兜底。
   *  生命周期随投影基线:openSession/startNewChat 置 [],snapshot/modelSelect 框架刷新。 */
  thinkingLevels: string[];
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
  /** 图锚升级(entryAppended 水合出 entryId 后):桌面图存储的 sendText hash 临时锚 → entryId 锚。 */
  hydrateImageAnchor: (sessionPath: string, sendText: string, entryId: string) => void;
  /** 会话删除后 prune 桌面图存储的孤儿条目(会话文件没了,图记录随之一并清)。 */
  pruneImageIndex: (sessionPaths: string[]) => void;
  /** 新会话落定(sessionStart 拿到真实路径):把发送时暂存在 new:<cwd> 占位键下的图记录
   *  迁到真实路径。发送时 currentSessionPath 尚为 null,recordImage 只能记 new:<cwd>;
   *  sessionStart 水合真实路径后迁走,否则首条图消息锚定失配、刷新后图不展示。 */
  adoptSessionImages: (cwd: string, sessionPath: string) => void;
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
   *     (底座 session_start 是纯扩展事件,永到不了 RPC stdout → renderer 永远等不到底座推
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
 *  底座事件 message.timestamp = LLM 调用开始时间(实测实证:assistant 的 msgTs ≈ 用户发送时刻,
 *  entry 级 timestamp 才是落盘/完成时间——两者差即一轮调用真实耗时)。
 *  圆心语义 timestamp=完成时间——流式期间完成时间未知,把开始时间挪进 startedAt、清掉 timestamp,
 *  权威完成时间由 entryAppended 落盘回执在水合时补(见下方水合分支)。
 *  注意:startedAt 可能仍为 undefined(底座事件缺 timestamp 的极端路径),消费方须兜底。 */
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
        // 与实发文本不同,仅按全文匹配必失配——底座回放被当成新消息追加,时间线双条。
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
    if (last && last.role === msg.role) return [...messages.slice(0, -1), { ...msg, pending: false }];
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
  if (event.type === "entryAppended") {
    const entry = (event as { entry?: unknown }).entry;
    if (!entry) return messages;
    const neutral = sessionEntryToNeutral(entry);
    if (!neutral) return messages;
    if ((entry as { type?: string }).type === "message") {
      // 消息条目落盘回执:消息体已由 messageStart/Update/End 渲染(底座 AgentMessage 无 id 字段),
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
    // 非消息条目(分隔线/custom 消息)按身份去重(防底座重复推送同一 entry)。
    // divider 的 content 恒为 ""(session-state.ts:372),不可用 textOf(content) 判重——
    // 否则任意两条 divider 互判重复,model/thinking 分隔线全被吞(根因)。
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== neutral.role) continue;
      if (m.role === "divider") {
        // 两条都有 id 按 id 判重;否则回退 kind+i18nKey+i18nArgs(底座条目恒带 id)。
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
  void window.pi.sessions.getStats()
    .then((s) => { if (gen === sessionGen) useSessionStore.setState({ stats: s as SessionStats }); })
    .catch(() => { /* pi 中途退出:保持现状,下轮事件再试 */ });
}

/** thinkingLevels 框架唯一拉取口:快照到达/模型切换时调(档位清单随模型变)。
 *  空清单不覆盖——底座异常回空时保持现值,与 stats 的 catch 兜底同语义。 */
function refreshThinkingLevels(): void {
  const gen = sessionGen;
  void window.pi.sessions.getThinkingLevels()
    .then((ls) => { if (gen === sessionGen && ls.length > 0) useSessionStore.setState({ thinkingLevels: ls }); })
    .catch(() => { /* pi 中途退出:保持现状,下次快照/切模型再试 */ });
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  snapshot: null,
  messages: [],
  imageIndex: {},
  stats: null,
  thinkingLevels: [],
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
      const list = (await window.pi.sessions.list(cwd)) as SessionInfo[];
      // 防竞态:拉取期间切了 cwd,旧响应丢弃
      if (useUiStore.getState().currentCwd !== cwd) return;
      const map: Record<string, SessionInfo> = {};
      for (const s of list) map[s.path] = s;
      useSessionStore.setState({ sessionInfos: map, sessionInfosCwd: cwd });
    } catch {
      // 拉取失败保持旧值(切 cwd 瞬间 main 未就绪等);下次触发重试
    }
  },
  openSession: async (sessionPath) => {
    sessionGen++;
    set({ switching: true });
    try {
      const detail = (await window.pi.sessions.openSession(sessionPath)) as SessionDetail | null;
      // 文件缺失/损坏:静默放弃(评估 M-5 的 cwd 落空防护保留——不进空会话、不 setContext),
      // 不以异常上报;初始/外部删除场景不应向用户抛错。
      if (!detail) {
        console.warn(`[session-store] 会话文件不可读,放弃打开: ${sessionPath}`);
        set({ switching: false });
        return false;
      }
      // 文件读即基线(秒开);同时记录发送上下文(cwd 取文件 header 的,最准)
      await window.pi.sessions.setContext(detail.info.cwd, sessionPath);
      // 显式设置 currentSessionPath(不依赖 sessionStart 事件的异步水合)
      useUiStore.getState().setCurrentSessionPath(sessionPath);
      set((s) => ({
        messages: detail.messages,
        // 从文件读回的存量 role:image 条目重建桌面图索引(兼容老会话;新数据在 session-images.json)
        imageIndex: buildImageIndexFromMessages(s.imageIndex, sessionPath, detail.messages),
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
      if (ui.currentSessionPath !== sessionPath) ui.setCurrentSessionPath(sessionPath);
      ui.setSessionTitle(deriveSessionTitle(detail.info));
      return true;
    } catch (err) {
      set({ switching: false });
      throw err;
    }
  },
  hydrateImageAnchor: (sessionPath, sendText, entryId) => {
    const s = get();
    const next = upgradeImageAnchor(s.imageIndex, sessionPath, sendText, entryId);
    if (next === s.imageIndex) return;
    set({ imageIndex: next });
    void persistSessionImages(next);
  },
  pruneImageIndex: (sessionPaths) => {
    const s = get();
    const targets = sessionPaths.filter((p) => p in s.imageIndex);
    if (targets.length === 0) return;
    const next = { ...s.imageIndex };
    for (const p of targets) delete next[p];
    set({ imageIndex: next });
    void persistSessionImages(next);
  },
  adoptSessionImages: (cwd, sessionPath) => {
    const from = `new:${cwd}`;
    if (from === sessionPath) return;
    const s = get();
    const pending = s.imageIndex[from];
    if (!pending) return;
    const next = { ...s.imageIndex };
    next[sessionPath] = { ...(next[sessionPath] ?? {}), ...pending };
    delete next[from];
    set({ imageIndex: next });
    void persistSessionImages(next);
  },
  startNewChat: async (cwd) => {
    sessionGen++;
    await window.pi.sessions.setContext(cwd, null);
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
    const snap = get().snapshot?.state;
    let needSync = false;
    let headerPrefsFailed: string | undefined;
    const pendingKey = ui.currentSessionPath ?? (cwd ? `new:${cwd}` : null);
    const pending = pendingKey ? ui.sessionModelPending[pendingKey] : undefined;
    if (pending && pendingKey) {
      try {
        await window.pi.sessions.setModel(pending.provider, pending.modelId);
        await window.pi.sessions.setThinkingLevel(pending.thinkingLevel);
        ui.clearSessionModelPending(pendingKey);
        needSync = true;
      } catch (err) {
        return { ok: false, reason: "modelPrefs", error: err instanceof Error ? err.message : String(err) };
      }
    } else if (ui.currentSessionPath) {
      const headerPrefs = await readHeaderPrefs(cwd, ui.currentSessionPath);
      if (headerPrefs) {
        const snapModelId = snap?.model ? `${snap.model.provider}/${snap.model.id}` : null;
        const headerModelId = `${headerPrefs.provider}/${headerPrefs.modelId}`;
        try {
          if (headerModelId !== snapModelId) {
            await window.pi.sessions.setModel(headerPrefs.provider, headerPrefs.modelId);
            needSync = true;
          }
          if (headerPrefs.thinkingLevel !== (snap?.thinkingLevel ?? null)) {
            await window.pi.sessions.setThinkingLevel(headerPrefs.thinkingLevel);
            needSync = true;
          }
        } catch (err) {
          headerPrefsFailed = err instanceof Error ? err.message : String(err);
        }
      }
    } else {
      // 新会话且无 pending(用户未在下拉框点选):settings.json 无默认模型时,底座
      // spawn 后静默回落内置默认模型(实证 0.83:get_state 报 anthropic/claude-opus-4-8,
      // 走 api.anthropic.com——用户没配该家 key 即 401,"新电脑配置了模型却发不出去"
      // 的根因)。显式对齐 models.json 声明序首项,与 timeline 显示链 models[0] 兜底
      // 同源(所见即所发);读配置失败不对齐不中止(保持底座默认行为,发送主路径优先)。
      try {
        const [settings, modelsCfg] = await Promise.all([
          window.pi.piSettings.get(),
          window.pi.models.get<ModelsConfig>(),
        ]);
        const hasDefault =
          typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string";
        const first = hasDefault ? null : firstModelOf(modelsCfg);
        if (first) {
          await window.pi.sessions.setModel(first.provider, first.modelId);
          needSync = true;
        }
      } catch (err) {
        // 对齐失败中止发送:首项模型不可用的报错(如 "Model not found: x/y")比
        // 底座回落后的 anthropic 401 更贴近用户配置,诊断价值更高;契约同 pending 分支。
        return { ok: false, reason: "modelPrefs", error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (needSync) await window.pi.sessions.sync().catch(() => {});

    let finalText = text;
    let toolFilterFlushed: { custom: boolean; count: number } | undefined;
    const sessionPath = ui.currentSessionPath;
    if (sessionPath) {
      try {
        const pendingTools = ui.pendingToolConfig?.sessionPath === sessionPath ? ui.pendingToolConfig : null;
        let toolCfg: SessionToolConfig | null;
        if (pendingTools && !pendingTools.flushed) {
          await window.pi.sessions.updateHeader(sessionPath, { toolConfig: pendingTools.config });
          ui.setPendingToolConfig({ ...pendingTools, flushed: true });
          toolCfg = pendingTools.config;
          toolFilterFlushed = { custom: toolCfg != null, count: toolCfg?.enabledToolIds?.length ?? 0 };
        } else {
          toolCfg = await window.pi.sessions.readToolConfig(sessionPath);
        }
        if (toolCfg && Array.isArray(toolCfg.enabledToolIds)) {
          const enabledTools = toolCfg.enabledToolIds;
          const gateInstalled = await window.pi.kernel.toolgateAvailable().catch(() => false);
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
    // __sendText 保持全文不变,作底座回放/落盘 entry 水合的匹配键(双轨第二轨冗余,演进)。
    get().appendOptimisticUser(sendText, sendText);
    // 图:桌面自持附加数据(乐观写 + 乐观展示)——写入桌面自己的 session-images.json,
    // 不 append custom_message 到底座会话文件(底座不感知、sync 会冲掉)。
    // 锚定两段式:发送时用 sendText hash 作临时锚,entryAppended 水合出 entryId 后升级。
    const imageOpt = opts?.image;
    if (imageOpt) {
      const src = imageOpt.src;
      const title = imageOpt.title;
      const cur = get();
      const lastUser = [...cur.messages].reverse().find((m) => m.role === "user");
      const sessionPath = useUiStore.getState().currentSessionPath ?? `new:${cwd}`;
      const nextIdx = lastUser
        ? recordImage(cur.imageIndex, sessionPath, lastUser, { src, title })
        : cur.imageIndex;
      set({
        messages: cur.messages.map((m, i) =>
          i === cur.messages.length - 1 && m.role === "user" ? { ...m, __image: { src, title } } : m),
        imageIndex: nextIdx,
      });
      // 乐观写:发送即落盘,不等 entryAppended(设计:"写自己的文件,不用等任何人")
      if (nextIdx !== cur.imageIndex) void persistSessionImages(nextIdx);
    }
    get().appendPendingAssistant();
    await window.pi.sessions.prompt(sendText);
    set((s) => ({ lastSendNonce: s.lastSendNonce + 1 }));
    return { ok: true, warning: headerPrefsFailed ? "headerPrefs" : undefined, error: headerPrefsFailed, toolFilterFlushed };
  },
}));
/** 桌面自持图存储:sessionPath → 锚(entryId 或 sendText hash) → {src, title}。
 *  图片是桌面附加数据——写桌面自己的 session-images.json,不 append custom_message
 *  到底座会话文件(底座不感知、sync 快照会冲掉)。展示独立于底座快照:
 *  - 发送时:recordImage 乐观写(临时锚 = sendText hash),立即 persist;
 *  - entryAppended 水合出 entryId 时:upgradeImageAnchor 升级为 id 锚;
 *  - 打开会话时:buildImageIndexFromMessages 从存量 role:image 条目建锚(user.id);
 *  - timeline 渲染 user 消息:按 id → sendText hash → content hash 顺序查。 */
const SESSION_IMAGES_PATH = "~/.my-harness-desktop/stickers/session-images.json";

/** 写 session-images.json(配置通道白名单内,withDirLock 由 main 侧保证)。失败静默,内存仍有效。 */
async function persistSessionImages(doc?: SessionStoreState["imageIndex"]): Promise<void> {
  try {
    await window.pi.configFile.set(SESSION_IMAGES_PATH, doc ?? useSessionStore.getState().imageIndex, "replace");
  } catch { /* 写失败:内存仍有效,下次写重试 */ }
}

/** 启动时读回 session-images.json(刷新/重载后图不丢)。 */
async function loadSessionImages(): Promise<void> {
  try {
    const doc = await window.pi.configFile.get(SESSION_IMAGES_PATH);
    if (doc && typeof doc === "object") {
      useSessionStore.setState({ imageIndex: doc as SessionStoreState["imageIndex"] });
    }
  } catch { /* 读失败忽略 */ }
}

/** 乐观记录图:锚 = user 消息的 sendText hash(优先)或内容 hash;临时锚,entryAppended 后升级。 */
function recordImage(
  imageIndex: SessionStoreState["imageIndex"],
  sessionPath: string,
  userMsg: { content?: unknown; __sendText?: string },
  img: { src: string; title?: string },
): SessionStoreState["imageIndex"] {
  const anchor = userMsg.__sendText ? contentHashOf(userMsg.__sendText) : contentHashOf(textOf(userMsg.content));
  const next = { ...imageIndex };
  next[sessionPath] = { ...(imageIndex[sessionPath] ?? {}), [anchor]: { ...img } };
  return next;
}

/** entryAppended 水合出 entryId 后,把 sendText hash 临时锚升级为 id 锚(纯桌面存储内部改写)。 */
function upgradeImageAnchor(
  imageIndex: SessionStoreState["imageIndex"],
  sessionPath: string,
  sendText: string,
  entryId: string,
): SessionStoreState["imageIndex"] {
  const per = imageIndex[sessionPath];
  if (!per) return imageIndex;
  const anchor = contentHashOf(sendText);
  if (!(anchor in per)) return imageIndex;
  const next = { ...imageIndex, [sessionPath]: { ...per } };
  next[sessionPath][entryId] = per[anchor];
  delete next[sessionPath][anchor];
  return next;
}

/** 从文件读回的存量 role:image 条目建锚(key = 前一条 user 的 entryId;老会话图照常显示)。 */
function buildImageIndexFromMessages(
  imageIndex: SessionStoreState["imageIndex"],
  sessionPath: string,
  messages: NeutralMessage[],
): SessionStoreState["imageIndex"] {
  let next = imageIndex;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "image") continue;
    const img = parseImageContent(m.content);
    if (!img) continue;
    for (let j = i - 1; j >= 0; j--) {
      const uid = messages[j].id;
      if (messages[j].role === "user" && uid) {
        next = { ...next, [sessionPath]: { ...(next[sessionPath] ?? {}), [uid]: { ...img } } };
        break;
      }
    }
  }
  return next;
}

let inited = false;

/** 快照应用(纯函数,可裸单测):空快照(新会话 warmup 的 start sync,底座尚未处理 prompt)
 *  不得冲掉乐观消息——否则首条消息的乐观回显被清、entryAppended 水合找不到锚、首图丢失。
 *  此时基线(snapshot)照常更新,但 messages 保留、syncNonce 不递增(无全量替换)。
 *  非空快照 = 权威全量替换:照常清旧消息、递增 syncNonce 触发 Virtuoso 重挂。 */
export function applySnapshot(s: SessionStoreState, snapshot: SyncSnapshot): Partial<SessionStoreState> {
  const msgs = snapshot.messages ?? [];
  const streaming = snapshot.state?.isStreaming ?? false;
  const hasOptimistic = s.messages.some((m) => m.__optimistic === true || m.pending === true);
  if (msgs.length === 0 && hasOptimistic) {
    return { snapshot, streaming, switching: false, ready: true };
  }
  return {
    snapshot,
    // 底座快照是投影基线(权威);图片展示不依赖它——桌面图片索引(imageIndex)独立存活
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
  // 读回桌面图存储(刷新/重载后图不丢)
  void loadSessionImages();

  window.pi.sessions.onSnapshot((snapshotRaw) => {
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
  const offKernel = window.pi.sessions.onKernelEvent((raw) => {
    const evt = raw as KernelEvent;
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
  window.pi.sessions.onEvent((eventRaw) => {
    const event = eventRaw as SessionEvent;
    if (event.type === "sessionStart") {
      const sf = event.sessionFile;
      if (typeof sf === "string" && sf) {
        const prev = useUiStore.getState().currentSessionPath;
        if (!prev) {
          const cwd = useUiStore.getState().currentCwd;
          if (cwd) useSessionStore.getState().adoptSessionImages(cwd, sf);
        }
        useUiStore.getState().setCurrentSessionPath(sf);
      }
    }
    if (event.type === "entryAppended") {
      // 图锚升级:底座写 user 消息条目(entryAppended)水合出 entryId 后,
      // 把发送时的 sendText hash 临时锚升级为 entryId 锚(纯桌面存储内部改写)。
      // textOf(entry.message.content) 即发送时的 sendText(= recordImage 的 __sendText 匹配键,
      // 与 applyEvent 的 id 水合同一文本源)——两者必相等,否则锚升级会失配。
      const entry = (event as { entry?: { type?: string; id?: string; message?: { role?: string; content?: unknown } } }).entry;
      if (entry?.type === "message" && entry.message?.role === "user" && entry.id) {
        const sp = useUiStore.getState().currentSessionPath;
        if (sp) useSessionStore.getState().hydrateImageAnchor(sp, textOf(entry.message.content), entry.id);
      }
    }
    if (event.type === "compactionEnd") {
      void window.pi.sessions.sync();
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
