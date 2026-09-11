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
import type { NeutralMessage, SessionDetail, SessionEvent, SyncSnapshot, ModelInfo, SessionState, SessionStats, SessionToolConfig, SessionModelPrefs, SessionInfo, KernelEvent, KernelId, ImageInput, DisplayMeta } from "@my-harness-desktop/shared";
import { sessionEntryToNeutral, messageContentText as textOf, parseSessionModelPrefs, deriveSessionTitle } from "@my-harness-desktop/shared";
import { useUiStore } from "./ui-store";
import { initNeutralMirror, useNeutralMirror, mirrorMessages } from "./neutral-mirror";

// ============ 内容镜像 + 执行态叠加(session-single-source §2.2/§3.2)============

/** 在飞工具结果登记表(toolCallStart/End 事件驱动,视图层单例):
 *  镜像条目在 messageEnd 定稿时可能尚无工具结果(pi 的 toolCall 块结果在下一事件才齐)——
 *  合并视图按 toolCallId 把结果/状态补到内容块上,与旧 applyEvent 的就地 patch 同语义。 */
const toolResultLedger = new Map<string, { result?: unknown; isError?: boolean; state?: string }>();

/** 把登记表里的工具结果/状态补到消息内容块上(合并视图用,纯函数不 mutate)。 */
function withToolResults(messages: NeutralMessage[], ledger: Map<string, { result?: unknown; isError?: boolean; state?: string }>): NeutralMessage[] {
  if (ledger.size === 0) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const content = m.content.map((b) => {
      if (typeof b !== "object" || b === null) return b;
      const block = b as Record<string, unknown>;
      if (block.type !== "toolCall" || typeof block.id !== "string") return b;
      const rec = ledger.get(block.id);
      if (!rec) return b;
      // 只补缺的:已定稿带结果的块不覆盖
      if (block.result !== undefined && rec.state !== "running") return b;
      changed = true;
      return { ...block, ...(rec.result !== undefined ? { result: rec.result } : {}), ...(rec.isError !== undefined ? { isError: rec.isError } : {}), ...(rec.state ? { state: rec.state } : {}) };
    });
    return changed ? { ...m, content } : m;
  });
  return changed ? out : messages;
}

/** 合并视图(纯函数,可单测):base = 中立层镜像内容(唯一内容源);overlay = 执行态暂存
 *  (乐观回显 + 流式占位)。镜像里已出现的乐观条目(同文 user)从叠加层摘除——转正即不双条。 */
export function mergeMirrorWithOverlay(
  base: NeutralMessage[],
  overlay: NeutralMessage[],
  ledger?: Map<string, { result?: unknown; isError?: boolean; state?: string }>,
): NeutralMessage[] {
  const mergedBase = ledger ? withToolResults(base, ledger) : base;
  if (overlay.length === 0) return mergedBase;
  const baseUserTexts = new Set(base.filter((m) => m.role === "user").map((m) => textOf(m.content)));
  const visible = overlay.filter((m) => !(m.role === "user" && baseUserTexts.has(textOf(m.content))));
  return [...mergedBase, ...visible];
}

/** 叠加层归约(纯函数;事件只驱动执行态,内容归镜像——session-single-source §3.3):
 *  messageStart/Update 只维护「流式占位」(至多一条 pending assistant);
 *  messageEnd 摘除占位(内容已由主侧写穿落中立层,回执先于本事件到达);
 *  toolCallStart/End 登记表 + 补占位内容块;agent 三态只动 streaming(在 store 里)。 */
export function applyOverlayEvent(overlay: NeutralMessage[], event: SessionEvent): NeutralMessage[] {
  const rawMsg = (event as { message?: NeutralMessage }).message;
  const msg = rawMsg && (event.type === "messageStart" || event.type === "messageUpdate" || event.type === "messageEnd")
    ? withStreamTiming(rawMsg)
    : rawMsg;
  if (event.type === "messageStart" && msg?.role === "assistant") {
    // 同一时刻至多一条在流式:先摘旧占位(防搁浅),再挂新占位。
    const rest = overlay.filter((m) => !(m.role === "assistant" && m.pending === true));
    return [...rest, { ...msg, pending: true, id: typeof msg.id === "string" ? msg.id : `stream-${++streamSeq}` }];
  }
  if (event.type === "messageUpdate" && msg) {
    // patch 流式占位(末条 pending assistant);无占位说明 messageStart 未到(乱序防御)——补一条
    for (let i = overlay.length - 1; i >= 0; i--) {
      const m = overlay[i];
      if (m.role === "assistant" && m.pending === true) {
        return overlay.map((x, j) => (j === i ? { ...x, ...msg, id: x.id, startedAt: x.startedAt ?? msg.startedAt, pending: true } : x));
      }
    }
    return [...overlay, { ...msg, pending: true, id: typeof msg.id === "string" ? msg.id : `stream-${++streamSeq}` }];
  }
  if (event.type === "messageEnd") {
    // 定稿:占位摘除(中立层回执先于本事件到达——主侧 dispatch 先写穿再广播视图流)。
    return overlay.filter((m) => !(m.role === "assistant" && m.pending === true));
  }
  if (event.type === "toolCallStart") {
    const toolCallId = String((event as { toolCallId?: unknown }).toolCallId ?? "");
    if (!toolCallId) return overlay;
    inflightToolCalls.add(toolCallId);
    toolResultLedger.set(toolCallId, { state: "running" });
    return overlay;
  }
  if (event.type === "toolCallEnd") {
    const toolCallId = String((event as { toolCallId?: unknown }).toolCallId ?? "");
    if (!toolCallId) return overlay;
    inflightToolCalls.delete(toolCallId);
    toolResultLedger.set(toolCallId, { result: (event as { result?: unknown }).result, isError: (event as { isError?: unknown }).isError === true, state: "done" });
    return overlay;
  }
  return overlay;
}
let streamSeq = 0;

/** 重算合并视图(镜像或叠加层任一变化后调):
 *  - 镜像就绪:内容归镜像(唯一内容源);
 *  - 已有会话基线加载中(ns 已指、镜像未回):保持现状(openSession 基线 paint);
 *  - 新会话壳(ns 未指):内容为空,只显叠加层(乐观回显/流式占位)。 */
function recomputeMessages(): void {
  const mirror = useNeutralMirror.getState();
  if (!mirror.session && mirror.ns) return;
  const base = mirror.session ? mirrorMessages(mirror.session, mirror.activeLineageId) : [];
  useSessionStore.setState((s) => ({
    messages: mergeMirrorWithOverlay(base, s.overlay, toolResultLedger),
  }));
}

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
  /** 消息流 = 中立层镜像内容 + 执行态叠加层(乐观回显/流式占位)的合并视图。
   *  内容真相源是中立层(neutral-mirror);事件不再拼内容(session-single-source §3.2)。 */
  messages: NeutralMessage[];
  /** 执行态叠加层:乐观回显的 user 气泡 + 流式 pending assistant 占位。 */
  overlay: NeutralMessage[];
  /** 会话统计(token 用量/上下文占用/tps)。双源:文件聚合基线(openSession 随 detail
   *  到达,打开即有)+ 活会话 RPC 真值(snapshot/轮次结束覆盖,带 tps/权威 contextUsage)。
   *  null = 未运行(新会话/空会话文件)。 */
  stats: SessionStats | null;
  /** 当前模型可用的思考档位清单(内核 get_available_thinking_levels;随模型变)。
   *  [] = 未运行(新会话/文件读历史会话),消费方按展示策略兜底。
   *  生命周期随投影基线:openSession/startNewChat 置 [],snapshot/modelSelect 框架刷新。 */
  thinkingLevels: string[];
  /** 当前会话后端的扩展能力面 + 内核归属(main 侧 capabilities 投影;extension=false 时
   *  steer/followUp/thinkingLevel/队列/导出等 pi 专属入口置灰,§7.6 显式降级;
   *  kernel/locked 供内核 TAB 置灰:locked 且非 kernel 的 TAB 不可切)。 */
  capabilities: { kernel: KernelId | null; locked: boolean; extension: boolean; thinking: boolean };
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
  /** 列表行本地补丁(§neutral-storage-split §2.6):headerChanged 广播/插件写成功后调用,
   *  就地改 sessionInfos 里那一行(path 与 ns 双键同改),不再全量重拉。patch 只认
   *  name/pinned/archived 三键(与广播 payload 契约一致);custom 是「模型域等头域变更」
   *  的补丁口——model 域写盘只广播 neutralChange(kind:header,见 neutral-mirror),
   *  不经 headerChanged,列表行的 custom 必须由此同步(否则时间线模型展示链读到陈旧
   *  custom,发送后回落兜底模型——「发送后输入框模型没固定」的根因)。 */
  applyHeaderPatch: (sessionPaths: string | string[], patch: { name?: string; pinned?: boolean; archived?: boolean; custom?: Record<string, unknown> }) => void;
  /** 列表行本地摘除(delete 广播/删除成功后):path 与 ns 别名键一起摘。 */
  removeSessionRows: (paths: string[]) => void;
  /** 打开历史会话:纯文件读,秒开,不启 pi。
   *  返回 false = 文件缺失/不可读(静默放弃,不进空会话、不 setContext——
   *  cwd 落空的防护语义不变,只是不再以异常噪音上报,由调用方决定如何呈现)。 */
  openSession: (sessionPath: string) => Promise<boolean>;
  /** 新会话:本地清空,零 RPC;进程在首次发送时按需起。
   *  会话上下文三连(path/ns/title)也在这里一并清——此前 projects.switchCwd / ⌘N /
   *  sessions-list.newSession 各自抄一遍,漏一个就留残影(§3.3 框架管通用,调用方只传参数)。 */
  startNewChat: (cwd: string) => Promise<void>;
  /** 恢复某项目上次看的会话:有记忆且打开成功 → 打开它;否则起新会话。
   *  切项目(switchCwd)与冷启动(app-main)共用这一个入口,两边语义不会漂。 */
  restoreForCwd: (cwd: string) => Promise<void>;
  /** 切项目(左栏项目行的唯一入口):落 cwd → 恢复该项目上次的会话 → 驱 UI 重 resync。
   *  幂等:点当前已激活的项目直接返回,不重载、不重开新会话。 */
  switchCwd: (cwd: string) => Promise<void>;
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
   *     该事件,真相源单一在 main,见 src/server/application/sessions/session-store.ts 两处注释)
   *  两层不冲突:乐观层管高亮即时性,权威层管最终一致性。
   *  勿删任何一层;官方修复见 src/server/application/sessions/session-store.ts 两处注释 */
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

/** 三级模型偏好解析(发送/续跑共用):pending(点选内存) > 会话头(已持久化) > 兜底首项。
 *  pending 键必须与 timeline 的写入键一致(§kernel-forkless §32 主键迁移后 timeline 用
 *  currentNeutralSessionId 写 sessionModelPending):用 path 键读会永远 miss,导致
 *  「选了 dsh 模型却回落 header/兜底 → 调度到 pi」。活会话=neutralSessionId,新会话壳=`new:${cwd}`。
 *  兜底失败抛错,由调用方决定如何显形。 */
async function resolveSessionModelPrefs(cwd: string): Promise<SessionModelPrefs | undefined> {
  const ui = useUiStore.getState();
  const pendingKey = ui.currentNeutralSessionId ?? (cwd ? `new:${cwd}` : null);
  const pending = pendingKey ? ui.sessionModelPending[pendingKey] : undefined;
  if (pending) return pending;
  if (ui.currentSessionPath) return (await readHeaderPrefs(cwd, ui.currentSessionPath)) ?? undefined;
  // 新会话且无 pending:显式对齐默认/首项模型(根因同旧注释,勿回退)。
  const model = await window.kernel.models.getFallbackModel();
  if (model) return { provider: model.provider, modelId: model.model, thinkingLevel: "", kernel: model.kernel };
  return undefined;
}

/** 系统发送面（插件自驱动发送的唯一入口，goal 续跑/原地续跑都走这里）：三级偏好解析
 *  + 透传服务端 prompt。与用户管线（sendMessage）的区别：不过输入框管线——无乐观回显、
 *  无待发队列、无工具闸拼装。prefs 缺省时框架解析（pending>头>兜底），插件不传也有归属——
 *  全新会话的首轮发送也需要模型归属，空偏好服务端只能抛「会话未启动」。 */
export async function promptSession(text: string, images?: ImageInput[], display?: DisplayMeta, prefs?: SessionModelPrefs): Promise<void> {
  let p = prefs;
  if (!p) {
    const cwd = useUiStore.getState().currentCwd;
    try {
      p = cwd ? await resolveSessionModelPrefs(cwd) : undefined;
    } catch {
      p = undefined; // 偏好解析失败不阻断发送——服务端还有头行/已起进程两条路
    }
  }
  await window.kernel.sessions.prompt(text, images, display, p);
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

/** 在飞工具调用集合(toolCallStart 标记,toolCallEnd 清除)。
 *  根因:toolCall 块的 state 字段在内核消息里从不写入(生产恒 undefined),而「工具正在执行、
 *  结果未回」这个量只能由事件序推导——ask 等交互式工具卡按 state==="running" 挂交互 UI。
 *  集合是视图层单例(每窗口一份),块分解器经参数注入读取(blocks.ts 保持纯函数)。 */
const inflightToolCalls = new Set<string>();
/** 读在飞工具集合(timeline 分解消息时传入)。 */
export function getInflightToolCalls(): ReadonlySet<string> {
  return inflightToolCalls;
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
 *  能力探测门槛(§7.6):pi 扩展面 或 dsh 补面(dsh-thinking-level.md)任一在才拉——
 *  避免对无切档面的会话静默发一个注定失败的 RPC。
 *  清单是**内核声明的能力面**,展示必须反映**当前 session 的那个内核**:空清单就是「该内核
 *  没有档位」的如实表达,不能用上一个内核的档位顶上(跨 session 串味——「展示不是跟着 session
 *  走」的根因)。失败路径由 .catch 兜住(保持现值),成功返回空就该清空。此前 `ls.length > 0`
 *  让空清单不覆盖,正是串味的来源。 */
export function refreshThinkingLevels(): void {
  const caps = useSessionStore.getState().capabilities;
  if (!caps.extension && !caps.thinking) return;
  const gen = sessionGen;
  void window.kernel.sessions.pi.getThinkingLevels()
    .then((ls) => { if (gen === sessionGen) useSessionStore.setState({ thinkingLevels: ls }); })
    .catch(() => { /* 内核中途退出/补面缺位:保持现状,下次快照/切模型再试 */ });
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
  overlay: [],
  stats: null,
  thinkingLevels: [],
  capabilities: { kernel: null, locked: false, extension: false, thinking: false },
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
    } catch (e) {
      // 拉取失败保持旧值(切 cwd 瞬间 main 未就绪等);下次触发重试。
      // **但失败必须留痕**:此前是空 catch —— 后端一旦整份 list 抛错(曾因某行 header 指向
      // 未装载的内核而整条 RPC 失败),这里把它吞成静默,症状就变成「侧栏一直空着/一直显示
      // 上一个项目的行」,而控制台一片干净,根因在几层之外。静默吞异常会把一个明确的
      // 后端错误放大成「UI 莫名其妙不更新」。
      console.error(`[session-store] 会话列表拉取失败(cwd=${cwd}),保留旧值:`, e);
    }
  },
  applyHeaderPatch: (sessionPaths, patch) => {
    const infos = useSessionStore.getState().sessionInfos;
    if (!infos) return;
    const paths = Array.isArray(sessionPaths) ? sessionPaths : [sessionPaths];
    let map: Record<string, SessionInfo> | null = null;
    for (const p of paths) {
      const cur = (map ?? infos)[p];
      if (!cur) continue;
      const next: SessionInfo = { ...cur };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.pinned !== undefined) next.pinned = patch.pinned;
      if (patch.archived !== undefined) next.archived = patch.archived;
      if (patch.custom !== undefined) next.custom = patch.custom;
      if (!map) map = { ...infos };
      map[p] = next;
      if (cur.neutralSessionId) map[cur.neutralSessionId] = next;
    }
    if (map) useSessionStore.setState({ sessionInfos: map });
  },
  removeSessionRows: (paths) => {
    const infos = useSessionStore.getState().sessionInfos;
    if (!infos) return;
    const map = { ...infos };
    for (const p of paths) {
      const cur = map[p];
      if (cur?.neutralSessionId) delete map[cur.neutralSessionId];
      delete map[p];
    }
    useSessionStore.setState({ sessionInfos: map });
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
      // 能力面经 capabilitiesChanged 事件推送(setContext→proc.start 就绪即广播),此处不散拉。
      // 显式设置 currentSessionPath(不依赖 sessionStart 事件的异步水合)
      useUiStore.getState().setCurrentSessionPath(detail.info.path);
      useUiStore.getState().setCurrentNeutralSessionId(detail.info.neutralSessionId ?? null);
      set((s) => ({
        messages: detail.messages,
        overlay: [], // 切会话清叠加层(旧会话的乐观回显/流式占位不带过来)
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
      // 写穿"每个项目上次看的会话"(ns 主键优先、投影路径兜底)——切项目/冷启动恢复用的记忆。
      // 写在"成功打开"这一刻而不是"切走那一刻":否则冷启动恢复拿到的是上次切出的会话,
      // 而不是退出时真正打开的那一个(用户实际看到的是后者)。
      ui.rememberSessionForCwd(detail.info.cwd, detail.info.neutralSessionId ?? detail.info.path);
      // 打开即拉一次活会话真值:新客户端(尤其浏览器)打开空闲会话时没有轮次事件可等,
      // 不拉则 stats 永停「—」占位;后端已被别的客户端/轮次起活时,这里立即补齐真值(多端一致)。
      // 后端未起(按需起,§1.5)→ getStats 拒绝,refreshStats 的 catch 兜底保持诚实态。
      refreshStats();
      return true;
    } catch (err) {
      set({ switching: false });
      throw err;
    }
  },
  startNewChat: async (cwd) => {
    sessionGen++;
    await window.kernel.sessions.setContext(cwd, null);
    // 能力面经 capabilitiesChanged 事件推送,此处不散拉。
    // 会话上下文三连随新会话一并清:ns 不清则新会话残留上一会话的主键(收藏/分叉会把
    // 新会话的消息锚到旧会话树上——静默错会话,比按钮不亮更糟);path/title 不清则高亮
    // 与面包屑停在已离开的会话上。
    useUiStore.getState().clearSessionContext();
    set({ messages: [], overlay: [], snapshot: null, stats: null, thinkingLevels: [], streaming: false, switching: false, ready: true });
  },
  restoreForCwd: async (cwd) => {
    if (!cwd) return;
    const remembered = useUiStore.getState().lastSessionByCwd[cwd];
    // 记忆里没有(首次访问该项目)或文件已被删/不可读(openSession 返回 false)→ 起新会话。
    // 两条路都走"新会话壳"(零 RPC,进程在首次发送时按需起),与切项目前的默认行为一致。
    if (remembered) {
      try {
        if (await get().openSession(remembered)) return;
      } catch (err) {
        // 恢复是"锦上添花",不是启动的必经步骤:一句坏记忆(会话被删/内容损坏/读盘报错)
        // 不许把切项目或冷启动打断——退到基线行为(新会话壳)并诚实留一条日志。
        console.warn("[session-store] 恢复上次会话失败,退新会话:", err);
      }
    }
    await get().startNewChat(cwd);
  },
  switchCwd: async (cwd) => {
    // 幂等:点当前已激活的项目 = 无操作(旧行为是"重开一个新会话",在新语义下等于
    // 无意义地丢掉当前会话——改掉)
    if (!cwd || cwd === useUiStore.getState().currentCwd) return;
    // 顺序:先落 cwd(落 prefs.lastCwd + 重读项目级 general.json,并触发框架拉新目录的
    // 会话清单),再恢复该项目上次的会话——openSession 会按会话头把 main 侧上下文对齐。
    useUiStore.getState().setCurrentCwd(cwd);
    await get().restoreForCwd(cwd);
    useUiStore.getState().bumpSession();
  },
  appendOptimisticUser: (text, sendText) => {
    set((s) => ({ overlay: [...s.overlay, {
      id: crypto.randomUUID(), role: "user", content: text,
      __sendText: sendText, __optimistic: true,
    }] }));
    recomputeMessages();
  },
  appendPendingAssistant: () => {
    // startedAt=占位创建时刻:首个流式事件到达前,渲染层的等待计时以此起算
    // (流式事件到达后以其内核时间戳为准,见 withStreamTiming)。
    set((s) => ({ overlay: [...s.overlay.filter((m) => !(m.role === "assistant" && m.pending === true)), { id: crypto.randomUUID(), role: "assistant", content: "", pending: true, startedAt: Date.now() }] }));
    recomputeMessages();
  },
  sendMessage: async (cwd, text, opts) => {
    // §atomic-send:三级来源(pending > 头 > fallback)拼一个 SessionModelPrefs,一次传给 main。
    // 差异执行 + 双写 + 发消息收进 SessionStore.prompt 编排,renderer 不再逐条 RPC。
    let prefs: SessionModelPrefs | undefined;
    try {
      prefs = await resolveSessionModelPrefs(cwd);
    } catch (err) {
      return { ok: false, reason: "modelPrefs", error: err instanceof Error ? err.message : String(err) };
    }
    const ui = useUiStore.getState();
    // pendingKey 仍按 §32 主键口径单独留档:发送成功后清 pending 用(resolveSessionModelPrefs 已消费其值)。
    const pendingKey = ui.currentNeutralSessionId ?? (cwd ? `new:${cwd}` : null);
    const pending = pendingKey ? ui.sessionModelPending[pendingKey] : undefined;

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
      set((s) => ({
        overlay: s.overlay.map((m, i) =>
          i === s.overlay.length - 1 && m.role === "user" ? { ...m, __image: { src, title } } : m),
      }));
      recomputeMessages();
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
      // 失败诚实收尾(§7.6 不静默残留):RPC 前挂的乐观回显 + assistant 占位随失败一起撤,
      // 否则时间线永远留着「已发出」的用户气泡 + 空占位,用户只见空消息不见报错,
      // 误以为「发不出去/卡死」(dsh session/setModel 坏面时期此残留是投诉的直接观感)。
      // 用户文本不丢:调用方(toast)报真实原因,输入框未清可重发。
      set((s) => {
        const ov = [...s.overlay];
        const last = ov[ov.length - 1];
        if (last && last.role === "assistant" && last.pending === true && !last.content) ov.pop();
        for (let i = ov.length - 1; i >= 0; i--) {
          const m = ov[i] as NeutralMessage & { __sendText?: string; __optimistic?: boolean };
          if (m.role === "user" && m.__optimistic === true && m.__sendText === sendText) { ov.splice(i, 1); break; }
        }
        return { overlay: ov, streaming: false };
      });
      recomputeMessages();
      return { ok: false, reason: "modelPrefs", error: err instanceof Error ? err.message : String(err) };
    }
    // 执行成功才消费意图(session-model-config.md §4.1):pending 保留到此刻,失败不吞。
    if (pending && pendingKey) {
      ui.clearSessionModelPending(pendingKey);
    }
    // 新会话物化(new: → 真身)的草稿清账(根因修复,勿回退):物化是事件异步,晚于发送
    // 完成是常态——草稿 hook 在键变更那一刻会把当前文本存回 new: 键,下次新会话(⌘N)
    // 复活已发送的文本。发送成功即清 new: 键残留(对既有会话是无害 no-op)。
    ui.clearComposerDraft(`new:${cwd}`);
    set((s) => ({ lastSendNonce: s.lastSendNonce + 1 }));
    return { ok: true, toolFilterFlushed };
  },
}));
let inited = false;

/** 快照应用(纯函数,可裸单测):空快照(新会话 warmup 的 start sync,内核尚未处理 prompt)
 *  不得冲掉乐观消息——否则首条消息的乐观回显被清、entryAppended 水合找不到锚、首图丢失。
 *  此时基线(snapshot)照常更新,但 messages 保留、syncNonce 不递增(无全量替换)。
 *  非空快照 = 权威全量替换:照常清旧消息、递增 syncNonce 触发 Virtuoso 重挂。 */
/** 快照应用(纯函数,可裸单测):快照只更新状态面(state/streaming/ready)——
 *  消息内容归中立层镜像(neutral-mirror),快照不再携带/替换消息数组(session-single-source §3.3)。 */
export function applySnapshot(s: SessionStoreState, snapshot: SyncSnapshot): Partial<SessionStoreState> {
  return {
    snapshot,
    streaming: snapshot.state?.isStreaming ?? false,
    switching: false,
    ready: true,
  };
}

/** sessionStart 水合(导出纯化以便单测):写 currentSessionPath + currentNeutralSessionId。
 *  中立主键优先用事件携带值(main 侧 dispatch 随 sessionStart 下发);
 *  缺省(旧 main/外部注入)才回落 sessionInfos 反查——新会话尚未进列表时反查恒落空,
 *  currentNeutralSessionId 留 null 会让收藏/分叉入口整批不渲染(根因修复,勿回退)。 */
export function hydrateSessionStart(event: SessionEvent): void {
  if (event.type !== "sessionStart") return;
  const sf = event.sessionFile;
  if (typeof sf !== "string" || !sf) return;
  const ui = useUiStore.getState();
  ui.setCurrentSessionPath(sf);
  const fromEvent = (event as { neutralSessionId?: unknown }).neutralSessionId;
  const ns =
    typeof fromEvent === "string" && fromEvent
      ? fromEvent
      : (useSessionStore.getState().sessionInfos?.[sf]?.neutralSessionId ?? null);
  const prevNs = ui.currentNeutralSessionId;
  const cwd = ui.currentCwd;
  ui.setCurrentNeutralSessionId(ns);
  // 会话键迁移(根因修复,勿删):这一刻会话键从「新会话壳」`new:${cwd}` 翻成真实 ns。
  // 读取侧一律用 currentNeutralSessionId ?? `new:${cwd}`,所以翻键瞬间旧键再没人读 ——
  // 用户刚点选的模型就此变成孤儿,输入框回落应用默认模型(用户症状:「发送之后输入框的
  // 模型没固定」),草稿/排队消息同理。搬一次键,三张按会话暂存的 map 一起跟着走。
  // 之前那版把"已修"寄托在头域镜像 → applyHeaderPatch 上,但新会话那一刻 sessionInfos
  // 里还没有这一行,补丁被早退丢弃且不重试 —— 修的是"陈旧",没修"键漂移"。
  if (cwd && prevNs === null && ns) {
    useUiStore.getState().carrySessionKey(`new:${cwd}`, ns);
  }
  // 新会话物化(首条消息落盘)在此刻才有 id:补记"该项目上次看的会话"。
  // 不写这一步,新会话壳期间的切换就没人记——下次切回该项目会回到更早那个会话。
  if (cwd) ui.rememberSessionForCwd(cwd, ns ?? sf);
}

/** 初始化 main→renderer 通道(幂等;应用启动时调一次)。 */
export function initSessionStore(): void {
  if (inited) return;
  inited = true;

  // 中立层镜像(session-single-source §3.2):基线 + 写穿回执,与事件路径双跑。
  initNeutralMirror();

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
  refreshCapabilities(); // 冷启动基线一次;此后能力面经 capabilitiesChanged/kernelChanged 事件 push,不散拉
  const offKernel = window.kernel.sessions.onKernelEvent((raw) => {
    const evt = raw as KernelEvent;
    if (evt.kind === "capabilitiesChanged") {
      // 能力面 push 收口:main 在能力变化点广播完整快照,renderer 直接采信,不再重拉。
      useSessionStore.setState({ capabilities: evt.capabilities });
      return;
    }
    if (evt.kind === "kernelChanged") {
      // 跨内核切换完成:能力面直接采信推来的快照(不重拉),再刷快照基线 + 会话列表,
      // 驱动三处内核标跟着切(§9.3)。
      useSessionStore.setState({ capabilities: evt.capabilities });
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

  // 第 21 项 + §neutral-storage-split §2.6:任一客户端改列表行(归档/置顶/改名/删除/复制),
  // 服务端广播 headerChanged——updateHeader/rename/delete 自带补丁,本地打行,不再全量重拉
  // (此前各端重拉一次 = 全目录整树 parse,被「归档次数×客户端数」乘法放大);
  // copy/bookmark/fork/clone 等产生/消减整行的罕见操作本地无行可补丁,重拉一次。
  // 可选调用:旧内核 API 面(含测试 mock)无此订阅时显式降级,不炸初始化。
  const offHeaderChanged = window.kernel.sessions.onHeaderChanged?.((info) => {
    if (info.kind === "delete") {
      useSessionStore.getState().removeSessionRows(info.paths);
      return;
    }
    if (info.kind === "rename") {
      useSessionStore.getState().applyHeaderPatch(info.sessionPath, { name: info.name });
      return;
    }
    if (info.kind === "updateHeader") {
      useSessionStore.getState().applyHeaderPatch(info.sessionPath, info.patch);
      return;
    }
    // copy/bookmark/deleteBookmark/fork/forkFromSession/clone:产生/消减整行的罕见操作,
    // 本地无行可补丁,重拉一次。
    loadForCwd();
  });
  void offHeaderChanged;

  // session:event 只含激活会话(main dispatch 已按 activeProcKey 过滤),
  // 后台会话的定稿/轮结束/新文件事件不会进这里——不必再担心视图被别的会话污染。
  //
  // 事件语义(session-single-source §3.3):事件只驱动执行态(流式占位/streaming 标志/
  // 统计触发),内容一律经中立层镜像(写穿回执 → applyNeutralChange → 重算合并视图)。
  window.kernel.sessions.onEvent((eventRaw) => {
    const event = eventRaw as SessionEvent;
    if (event.type === "sessionStart") {
      hydrateSessionStart(event);
      // 能力面随 capabilitiesChanged 事件推送(setContext→proc.start 就绪即广播),
      // 首发时 extension 转真由该事件带到,此处不散拉 refreshCapabilities。
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
        overlay: applyOverlayEvent(s.overlay, event),
        streaming,
        snapshot: patched ? { ...s.snapshot!, state: patched } : s.snapshot,
      };
    });
    recomputeMessages();
  });

  // 中立层镜像变化 → 重算合并视图;活跃分支切换(整树换内容)→ 递增 syncNonce
  // 驱动 timeline Virtuoso 重挂(与 openSession 的 openNonce 同语义)。
  let lastLineage = useNeutralMirror.getState().activeLineageId;
  // 镜像头域引用(变了才同步 sessionInfos,避免每条 entry 变更都重写列表行)。
  let lastMirrorHeader = useNeutralMirror.getState().session?.header ?? null;
  useNeutralMirror.subscribe((m) => {
    if (m.activeLineageId !== lastLineage) {
      const wasNull = lastLineage === null;
      lastLineage = m.activeLineageId;
      // 初始基线(null→ns)不重挂:那是 openSession 的 openNonce 职责。此前这里对
      // 初始基线也递增 syncNonce,刷新/重开时 openNonce 与 syncNonce 双重重挂 Virtuoso,
      // 与异步 data 的并发提交竞态 → 偶发空渲染(重开后 store 有消息但时间线空白,§根因)。
      // 只在「从一条已物化 lineage 切到另一条」(wasNull=false)时递增,清空(ns→null)仍递增
      // (新会话壳要重挂空列表)。
      if (!wasNull) {
        useSessionStore.setState((s) => ({ syncNonce: s.syncNonce + 1 }));
      }
    }
    // **关键路径先跑**:消息重算是渲染命脉,排在列表行同步之前——后者会 setState 触发渲染,
    // 让命脉依赖一个非命脉副作用是不必要的耦合。注意:这**不是**「重开后空时间线」的修复
    // ——把本文件回退到 HEAD 版本后该症状同样间歇复现(已隔离实测),属既有缺陷,见 skills §10.3 第 3 条。
    recomputeMessages();
    // 头域同步(根因修复):model 域(provider/modelId/thinkingLevel/kernel)写盘只广播
    // neutralChange(kind:header)进镜像,不经 headerChanged——sessionInfos 列表行的 custom
    // 因此陈旧,时间线模型展示链(headerPrefs = parseSessionModelPrefs(sessionInfos[ns].custom))
    // 在发送后回落兜底模型(「发送后输入框模型没固定」的根因)。镜像头域是当前会话的新鲜真相,
    // 引用一变即补丁到 sessionInfos(按 ns 键,与 loadSessionInfos 的双键同源)。
    const h = m.session?.header ?? null;
    if (h !== lastMirrorHeader) {
      lastMirrorHeader = h;
      if (h && m.ns) {
        try {
          useSessionStore.getState().applyHeaderPatch(m.ns, {
            name: h.name, pinned: h.pinned, archived: h.archived, custom: h.custom,
          });
        } catch { /* 列表行同步失败不影响会话读路径 */ }
      }
    }
  });
}
