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
import type { NeutralMessage, SessionDetail, SessionEvent, SyncSnapshot, ModelInfo, SessionState, SessionStats, SessionToolConfig, SessionModelPrefs, ModelsConfig } from "@pi-desktop/contract";
import { sessionEntryToNeutral, messageContentText as textOf, parseSessionModelPrefs, firstModelOf } from "@pi-desktop/contract";
import { useUiStore } from "./ui-store";

// ── 工具限制注入(从 timeline 收编,发送统一入口的构成部分) ──────────────
// 注入文本是发往底座的协议指令(渲染层经 stripToolLimitNote 剥除,用户气泡不可见),
// 非 UI 文案——演进:底座提供工具白名单 RPC 后整体移除(勿 i18n,勿当界面文案改)。
const TOOL_LIMIT_PREFIX = "[System] 本次会话已限制可用工具。";
export function buildToolLimitNote(tools: string[]): string {
  return TOOL_LIMIT_PREFIX + "\n可用工具: " + tools.join(", ") + "\n请勿使用未在列表中的工具。";
}
export function stripToolLimitNote(text: string): string {
  if (!text.startsWith(TOOL_LIMIT_PREFIX)) return text;
  const sep = text.indexOf("\n\n");
  return sep >= 0 ? text.slice(sep + 2) : "";
}

/** sendMessage 结果:ok=false 即偏好回灌失败中止(不发送);warning=头对齐失败不中止;
 *  toolFilterFlushed 供调用方弹"工具过滤已应用"提示。 */
/** user 消息回显上的附件徽章:发送方(sendMessage opts.echoAttachments)挂在乐观消息上,
 *  水合 spread 存活;水合到权威 entryId 时连同 echo 正文持久化进会话头行 custom 域
 *  (persistEchoAttachments,域级浅合并),openSession/onSnapshot 基线替换后按 id 回贴
 *  (徽章+正文),切会话/resync/重启不再丢失。
 *  形状与 timeline:composerAttachments 的 items 元素同构,timeline 可直接透传。 */
export interface EchoAttachment {
  seq: string;
  quotePreview: string;
  comment: string;
}

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
  /** 可展示(有消息基线,不论来自文件还是 pi) */
  ready: boolean;
  /** 发送序号:sendMessage 成功后递增。timeline 订阅它做"发送后滚底清未读"——
   *  所有发送入口(composer/rewind/notes)的行为由构造强制一致,入口无需自己收尾。 */
  lastSendNonce: number;
  /** 打开历史会话:纯文件读,秒开,不启 pi。
   *  返回 false = 文件缺失/不可读(静默放弃,不进空会话、不 setContext——
   *  cwd 落空的防护语义不变,只是不再以异常噪音上报,由调用方决定如何呈现)。 */
  openSession: (sessionPath: string) => Promise<boolean>;
  /** 新会话:本地清空,零 RPC;进程在首次发送时按需起。 */
  startNewChat: (cwd: string) => Promise<void>;
  /** 用户发消息后乐观回显(等 messageEnd(user) 到了去重) */
  appendOptimisticUser: (text: string, sendText: string, echoAttachments?: EchoAttachment[]) => void;
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
   sendMessage: (cwd: string, text: string, opts?: { sendSuffix?: string; echoAttachments?: EchoAttachment[] }) => Promise<SendMessageResult>;
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
  const msg = (event as { message?: NeutralMessage }).message;
  if (event.type === "messageUpdate" && msg) {
    if (msg.id) {
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) return messages.map((m, i) => i === idx ? { ...m, ...msg, pending: true } : m);
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
        // 匹配键双轨(根因修复,勿回退):echo/send 双形态下(附件/工具前缀)乐观回显
        // 与实发文本不同,仅按全文匹配必失配——底座回放被当成新消息追加,时间线双条。
        // __sendText 是发送时随乐观消息携带的实发全文,与回放全文精确对齐。
        // 命中后保留乐观消息的 echo 内容(content/echoAttachments),只吸收回放权威字段。
        if (m.role === "user" && m.__optimistic === true
          && (textOf(m.content) === text || m.__sendText === text)) {
          return messages.map((x, idx) => idx === i
            ? { ...x, ...msg, content: x.content, echoAttachments: x.echoAttachments, pending: true, __optimistic: true }
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
      if (idx >= 0) return messages.map((m, i) => i === idx ? { ...msg, pending: false, stopped: false } : m);
    }
    const last = messages[messages.length - 1];
    if (last && last.role === msg.role) return [...messages.slice(0, -1), { ...msg, pending: false }];
    if (msg.role === "user") {
      const text = textOf(msg.content);
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        // 同 messageStart 的 user 分支:__sendText 双轨匹配,命中保留 echo 内容并转正。
        if (m.role === "user" && m.__optimistic === true
          && (textOf(m.content) === text || m.__sendText === text)) {
          return messages.map((x, idx) => idx === i
            ? { ...x, ...msg, content: x.content, echoAttachments: x.echoAttachments, __optimistic: false }
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
        x.__optimistic === true ? { ...x, id: neutral.id, __optimistic: false } : { ...x, id: neutral.id };
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

/** stats 框架唯一拉取口:快照到达/轮次结束时调。
 *  就绪闸天然成立——这两类时机都意味着 pi 活着;新会话/文件读根本走不到这里。 */
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
  stats: null,
  thinkingLevels: [],
  streaming: false,
  switching: false,
  syncNonce: 0,
  ready: false,
  lastSendNonce: 0,
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
      // echo 回显持久镜像水合 + 基线回贴:重扫重建的消息无回显元数据,
      // 从头行 custom 域按权威 entryId 回贴(persistEchoAttachments 的逆向)。
      // normalize 兼容历史落盘形态(裸数组/对象),脏条目丢弃。
      const persistedEcho = normalizeEchoMirror(detail.info.custom?.[ECHO_HEADER_DOMAIN]);
      echoMirrorBySession.set(sessionPath, persistedEcho);
      for (const id of Object.keys(persistedEcho)) persistedEchoIds.add(id);
      applyEchoMirror(detail.messages, persistedEcho);
      // 文件读即基线(秒开);同时记录发送上下文(cwd 取文件 header 的,最准)
      await window.pi.sessions.setContext(detail.info.cwd, sessionPath);
      set({
        messages: detail.messages,
        snapshot: null,
        // 文件聚合基线:打开即有,不依赖活进程;活会话 snapshot/RPC 真值到达后覆盖
        stats: detail.stats,
        thinkingLevels: [],
        streaming: false,
        switching: false,
        ready: true,
      });
      return true;
    } catch (err) {
      set({ switching: false });
      throw err;
    }
  },
  startNewChat: async (cwd) => {
    sessionGen++;
    await window.pi.sessions.setContext(cwd, null);
    set({ messages: [], snapshot: null, stats: null, thinkingLevels: [], streaming: false, switching: false, ready: true });
  },
  appendOptimisticUser: (text, sendText, echoAttachments) => {
    set((s) => ({ messages: [...s.messages, {
      id: crypto.randomUUID(), role: "user", content: text,
      __sendText: sendText, echoAttachments, __optimistic: true,
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
          toolFilterFlushed = { custom: toolCfg?.mode === "custom", count: toolCfg?.enabledToolIds?.length ?? 0 };
        } else {
          toolCfg = await window.pi.sessions.readToolConfig(sessionPath);
        }
        if (toolCfg?.mode === "custom") {
          const enabledTools = toolCfg.enabledToolIds ?? [];
          const gateInstalled = await window.pi.kernel.toolgateAvailable().catch(() => false);
          if (enabledTools.length > 0 && !gateInstalled) {
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
    // 乐观回显只放正文;附件以 echoAttachments 结构化挂载(timeline 渲染徽章条,非文本行)。
    // __sendText 随消息携带,作底座回放/落盘 entry 水合的匹配键(双形态去重,根因修复)。
    get().appendOptimisticUser(text, sendText, opts?.echoAttachments);
    get().appendPendingAssistant();
    await window.pi.sessions.prompt(sendText);
    set((s) => ({ lastSendNonce: s.lastSendNonce + 1 }));
    return { ok: true, warning: headerPrefsFailed ? "headerPrefs" : undefined, error: headerPrefsFailed, toolFilterFlushed };
  },
}));

// ── echo 回显持久化(会话头行 custom 域) ───────────────────────────────
// echo 形态(正文气泡 + 徽章条)只随乐观消息在内存存活,openSession/onSnapshot 基线
// 替换(重扫 JSONL / RPC 重放)整表重建 NeutralMessage 即丢:content 变成发给模型的
// 合并全文,徽章无元数据。此镜像把回显(正文 + 徽章)按权威 entryId 持久化进会话头行
// custom 域(updateHeader 域级浅合并,兄弟域 pin/archive/toolConfig 零影响,语义
// docs/design/session-header-custom.md §2.2),基线替换后按 id 回贴——展示基于文件,
// 发送时与重载后同一形态。
const echoMirrorBySession = new Map<string, Record<string, PersistedEchoEntry>>();
const persistedEchoIds = new Set<string>();
/** 头行 custom-pi-desktop 域名:desktop 功能域(docs/design/session-header-custom.md §2.1),
 *  唯一写入方为本模块;值形 { [entryId]: PersistedEchoEntry }。 */
const ECHO_HEADER_DOMAIN = "echoAttachments";
/** 头行与 subagent/toolConfig 共享 8KB 热读预算(session-header-custom §2.4):条数与序列化双闸。 */
const ECHO_MAX_PERSISTED = 15;
const ECHO_SERIALIZE_BUDGET = 3072;
/** 单条 echo 正文落盘上限:头行是 8KB 热读预算,单条不设上限会让一条长正文把整个
 *  custom 域顶爆(读取链静默失效,连累 pin/archive/toolConfig)。超长正文气泡本就
 *  折叠显示,截断只影响重载后的展示形态。 */
const ECHO_BODY_MAX = 500;

/** 头行持久化的单条回显。echo 必须落盘:重扫后 content 是发给模型的合并全文
 *  (正文+评论拼装片段),气泡直接渲会裸露拼装文本;拼装格式用户可配、不可反解析
 *  (review-plugin 设计 §1.3),显示态正文只能随徽章一起存。
 *  echo 可选:早期裸数组形态无正文可恢复,归一条目缺 echo(徽章照回贴、正文不覆盖)。 */
export interface PersistedEchoEntry {
  /** 发送时用户看到的正文(echo 形态,不含工具前缀、不含评论拼装片段) */
  echo?: string;
  items: EchoAttachment[];
}

/** 头行与 subagent/toolConfig 共享 8KB 热读预算(设计 §2.4):只留展示所需最小字段并截断。 */
export function sanitizeEchoAttachments(items: readonly EchoAttachment[]): EchoAttachment[] {
  return items.map((it) => ({
    seq: it.seq,
    quotePreview: it.quotePreview.length > 60 ? it.quotePreview.slice(0, 60) : it.quotePreview,
    comment: it.comment.length > 160 ? it.comment.slice(0, 160) : it.comment,
  }));
}

/** 头行读回的原始值 → 规范镜像。历史形态兼容:早期版本值是裸数组(只存徽章不存
 *  正文)→ 归一为无 echo 条目(徽章照回贴,正文不覆盖);垃圾条目(非数组非对象、
 *  items 空)丢弃,不进镜像不占预算。 */
export function normalizeEchoMirror(raw: unknown): Record<string, PersistedEchoEntry> {
  const out: Record<string, PersistedEchoEntry> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const items = validEchoItems(Array.isArray(v) ? v : (v as { items?: unknown } | null)?.items);
    if (items.length === 0) continue;
    const echo = !Array.isArray(v) && typeof (v as { echo?: unknown }).echo === "string"
      ? (v as { echo: string }).echo
      : undefined;
    out[id] = echo === undefined ? { items } : { echo, items };
  }
  return out;
}

function validEchoItems(arr: unknown): EchoAttachment[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter((it): it is EchoAttachment =>
    !!it && typeof it === "object"
    && typeof (it as EchoAttachment).seq === "string"
    && typeof (it as EchoAttachment).quotePreview === "string"
    && typeof (it as EchoAttachment).comment === "string")
    .map((it) => ({ seq: it.seq, quotePreview: it.quotePreview, comment: it.comment }));
}

export function trimEchoMirror(mirror: Record<string, PersistedEchoEntry>): void {
  while (Object.keys(mirror).length > ECHO_MAX_PERSISTED) delete mirror[Object.keys(mirror)[0]];
  while (Object.keys(mirror).length > 1 && JSON.stringify(mirror).length > ECHO_SERIALIZE_BUDGET) {
    delete mirror[Object.keys(mirror)[0]];
  }
}

/** 基线重建的消息没有回显元数据:按权威 entryId 从头行镜像回贴(幂等,缺则不动)。
 *  徽章挂上;echo 非空时正文换回 echo 形态。echo 为空不回贴正文:早期版本落盘的
 *  空 echo 是写入侧 bug 的脏数据,回贴会把用户正文抹成空气——宁可裸露合并全文,
 *  不可丢字。 */
export function applyEchoMirror(messages: NeutralMessage[], mirror: Record<string, PersistedEchoEntry> | undefined): void {
  if (!mirror) return;
  for (const m of messages) {
    const cur = m.echoAttachments as EchoAttachment[] | undefined;
    if (m.role === "user" && m.id && !cur?.length) {
      const entry = mirror[m.id];
      if (!entry) continue;
      m.echoAttachments = entry.items;
      if (entry.echo) m.content = entry.echo;
    }
  }
}

/** 本次 entryAppended 刚水合的那条消息(键恒等于事件的权威 entryId)若带徽章 →
 *  域级浅合并写会话头行;镜像持全量,天然契合域内整体替换语义(session-scanner
 *  锁内读-改-写,兄弟域零影响)。键只取事件 entry.id:乐观期临时 uuid 物理上不可能
 *  入头行(水合失败/乱序时不会写垃圾键)。fire-and-forget:失败 warn 不阻断会话。 */
function persistEchoAttachments(entryId: string | undefined): void {
  if (!entryId || persistedEchoIds.has(entryId)) return;
  const path = useUiStore.getState().currentSessionPath;
  if (!path) return;
  const m = useSessionStore.getState().messages.find((x) => x.id === entryId);
  const atts = m?.echoAttachments as EchoAttachment[] | undefined;
  if (!m || !atts?.length) return;
  let mirror = echoMirrorBySession.get(path);
  if (!mirror) {
    mirror = {};
    echoMirrorBySession.set(path, mirror);
  }
  const body = textOf(m.content);
  mirror[entryId] = {
    echo: body.length > ECHO_BODY_MAX ? body.slice(0, ECHO_BODY_MAX) : body,
    items: sanitizeEchoAttachments(atts),
  };
  persistedEchoIds.add(entryId);
  trimEchoMirror(mirror);
  void window.pi.sessions
    .updateHeader(path, { custom: { [ECHO_HEADER_DOMAIN]: mirror } })
    .catch((err: unknown) => console.warn("[session-store] echoAttachments 头行持久化失败:", err));
}

let inited = false;
/** 初始化 main→renderer 通道(幂等;应用启动时调一次)。 */
export function initSessionStore(): void {
  if (inited) return;
  inited = true;

  window.pi.sessions.onSnapshot((snapshotRaw) => {
    const snapshot = snapshotRaw as SyncSnapshot;
    // 基线替换回贴:RPC 重放重建消息无徽章元数据,按权威 entryId 从头行镜像回贴
    const mirror = echoMirrorBySession.get(useUiStore.getState().currentSessionPath ?? "");
    const msgs = snapshot.messages ?? [];
    applyEchoMirror(msgs, mirror);
    useSessionStore.setState((s) => ({
      snapshot,
      messages: msgs,
      streaming: snapshot.state?.isStreaming ?? false,
      switching: false,
      syncNonce: s.syncNonce + 1,
      ready: true,
    }));
    refreshStats();
    refreshThinkingLevels();
  });

  // session:event 只含激活会话(main dispatch 已按 activeProcKey 过滤),
  // 后台会话的定稿/轮结束/新文件事件不会进这里——不必再担心视图被别的会话污染。
  window.pi.sessions.onEvent((eventRaw) => {
    const event = eventRaw as SessionEvent;
    if (event.type === "sessionStart") {
      const sf = event.sessionFile;
      if (typeof sf === "string" && sf) {
        useUiStore.getState().setCurrentSessionPath(sf);
      }
    }
    if (event.type === "compactionEnd") {
      void window.pi.sessions.sync();
    }
    if (event.type === "messageEnd" || event.type === "agentSettled" || event.type === "agentEnd") {
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
    // 必须在 setState 之后:persist 按事件的权威 entryId 反查消息,水合(setState 内的
    // applyEvent)完成前消息 id 还是临时 uuid,反查永不命中、徽章永不落盘(根因修复)。
    if (event.type === "entryAppended") {
      persistEchoAttachments((event as { entry?: { id?: string } }).entry?.id);
    }
  });
}
