// 会话存储 —— application 层:多会话多 pi 进程调度。
//
// 进程模型(用户拍板):会话是文件,进程是按需的临时工,且**每会话一进程、多会话多进程**。
// - 看会话 = 读文件(session-scanner.readSession),不启 pi
// - 发消息 = 按需起该会话的 pi:ensureForSend 保证激活会话的 pi 在跑,
//   不杀其他会话的进程(多会话并存)
// - 切会话:setContext 设激活;激活会话 pi 活着则 resync 推基线,没活则等 prompt 时起
// - pi 启动/关闭不阻塞展示:进程动作全在发送路径上
//
// 依赖倒置:本层不 new RpcAdapter(那是 gateway 具体类),而是持 RpcAdapterFactory
// 接口(本层拥有),实现由 shell 注入。换运行时只换 factory 实现,本文件一行不改。
// application 依赖 gateway(type)+ domain,不依赖 shell。
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { BaseBackend, BackendFactory, LineageTree, SessionCatalog, SessionCatalogFactory } from "@my-harness-desktop/shared";
import { BOOKMARK_SNAPSHOT_VERSION, materializeLineagePrefix, type BookmarkSnapshot } from "@my-harness-desktop/shared";
import type { PiBackendExtensions } from "../../kernel/pi/backend/pi-backend-extensions";
import { KERNEL_IDS, type KernelId } from "@my-harness-desktop/shared";
import type { NeutralSession, NeutralModelRef, DisplayMeta, NeutralEntry, NeutralSessionHeader, NeutralChange } from "@my-harness-desktop/shared";
import { neutralEntryId, sortLineagesTopologically, resolveForkBoundaries, emptyNeutralSession, appendNeutralEntry, appendNeutralEntryWithHeader, derivedHeaderFromSession, upsertNeutralLineage, backfillUserAuthority, backfillKernelEntryId, lineageContent, assembleSeedProjection, cloneNeutralSession, resolveBoundaryEntryId, resolveForkBoundary, neutralMessagesOfSession, neutralSessionToTree } from "@my-harness-desktop/shared";
import { NeutralSessionStore } from "./neutral-session-store";
import { BookmarkSnapshotStore } from "./bookmark-snapshot-store";
import { PendingQuestionStore } from "./pending-question-store";
import type { SessionEvent, SyncSnapshot, ModelInfo, SessionStats, ProjectStats, NeutralMessage, TurnUsage, TreeNode } from "@my-harness-desktop/shared";
import { isVisibleMessage, deduplicateAdjacent, messageUsageOf, resolveContextUsage, sessionEntryToNeutral, shellSessionStats } from "@my-harness-desktop/shared";
import type { KernelEvent, QuestionRequestEvent, QuestionAnswer, SessionCapabilities, PendingQuestionRecord, Question, ToolResultWriteback } from "@my-harness-desktop/shared";
import type { SessionStoreForRestart } from "@my-harness-desktop/shared";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, PiExtensions, BashApi,
  ImageInput, BashResult, SessionInfo, HeaderPatch, SessionDetail, SessionToolConfig, ModelTestResult,
  SessionModelPrefs, SessionRole, KnownToolInfo, SessionRawFilePaths,
} from "@my-harness-desktop/shared";
import { truncateSessionName, messageContentText, SESSION_MODEL_PREFS_KEY, parseSessionModelPrefs, roleToPrompt } from "@my-harness-desktop/shared";

import type { ModelCatalog } from "../models/model-catalog";
import { classifyModel } from "../models/model-catalog";
import { randomUUID } from "node:crypto";


/** 后端工厂抽象在圆心 domain/backend 的 BackendFactory(契约单源,kernel-layer.md §2.2)。
 *  shell 注入实现:create(BackendCreateOptions) 返回一个已实现 BaseBackend 的后端(pi 或 dsh),
 *  调用方再 .start()。内核专属 spawn 参数由实现闭包捕获,application 不感知子进程。 */
export type { BackendFactory } from "@my-harness-desktop/shared";

function zeroTurnUsage(): TurnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** fork/clone 产物命名:源名 + " (copy)" 后缀;无源名回落 "copy"。
 *  后缀是固定英文文案(会话名是用户数据,不走 i18n)。 */
function forkCopyName(sourceName?: string | null): string {
  const base = sourceName?.trim();
  return base ? `${base} (copy)` : "copy";
}

/** 空快照基线(无快照面内核的组装底座)。thinkingLevel 置空串(诚实未知——
 *  档位是 pi 语义,其他内核没有;渲染链对空串自然回落头域/默认,不伪造)。 */
function emptySnapshot(): SyncSnapshot {
  return {
    state: {
      thinkingLevel: "",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: "",
      autoCompactionEnabled: false,
      messageCount: 0,
      pendingMessageCount: 0,
    },
    entries: [],
    messages: [],
    tree: [],
    commands: [],
    leafId: null,
  };
}

/** abort 命令超时(ms):agent.abort 会等 waitForIdle,工具未响应 agent signal 中断时阻塞。
 *  正常中止 1-2 秒返回,慢收尾留 8 秒余量;超时视为中断失败,由 abort() 强杀进程兜底。 */
const ABORT_TIMEOUT_MS = 8_000;

/** 配置文件依赖快照项:path + mtimeMs。文件不存在记 -1(存在性变化同样视为配置变更)。 */
interface ConfigSnapshotEntry {
  path: string;
  mtimeMs: number;
}

interface SessionProc {
  backend: BaseBackend;
  /** 会话当前内核(pi/dsh)。跨内核切换(§3.6)时改写;路由 factory + asPi 类型守卫依据。 */
  kernel: KernelId;
  /** 进程出生证(ask-design §4.3):每次创建/换绑(materialize/switchKernel)重新生成。
   *  提问落账时记录;answer 时比对——匹配且活着 = 活路,不匹配 = 续路。 */
  nonce: string;
  /** 最近一次 ask_user_question 的 toolCallStart 对账(dispatch 捕获):提问落账的
   *  toolCallId + 模型原始 questions(真实 q.id 来源;帧/文件里的是合成 id)。 */
  lastAskToolCallId?: string;
  lastAskQuestions?: Question[];
  /** 中立会话主键(壳生成、跨内核稳定)。映射表记录各内核私有 id 绑定,回切找回原会话
   *  (session-neutral-layer.md §5/§16)。 */
  neutralSessionId: string;
  cwd: string;
  /** procs 当前 map key(初始 = sessionPath 或 new:${cwd})。fork/clone 对账经 rekeyProc
   *  迁到新会话文件路径,恒等于 boundSessionPath("key === 绑定路径"不变量);
   *  事件闭包按 proc.key 路由,迁移不丢转发。 */
  key: string;
  boundSessionPath: string | null;
  genStartMs: number | null;
  lastTps: number | null;
  /** 本轮输出 token 与生成时长(秒)的累计:agentStart 清零、messageEnd 累加,
   *  lastTps = roundOut/roundGenSec 即本轮加权速率——一轮多条 assistant 消息(工具循环)
   *  时不再定格在最后一条(往往最短)的瞬时速率。 */
  roundOut: number;
  roundGenSec: number;
  /** 本轮用量累计:agentStart 归档到 lastTurn 并清零,messageEnd 按 messageUsageOf 累加。
   *  翻轮只在 agentStart(agentEnd/agentSettled 同帧双发,先到者清零后到者再覆盖会恒 0)。 */
  turn: TurnUsage;
  /** 上一次完成轮用量;null=本进程内尚无完成轮。 */
  lastTurn: TurnUsage | null;
  /** 完成回合数:agentSettled 累计(跨内核中性事件;pi 的 agent_settled / dsh 的 turn/end)。 */
  turns: number;
  /** 完成的单次模型调用数:stepEnd 累计(pi 的 turn_end / dsh 的 step/end)。 */
  steps: number;
  /** 内核上下文锚点可信度:最后一条带 usage 的 assistant 消息是否真测到 prompt
   *  (input+cacheRead+cacheWrite>0)。false 时 getStats 用 context-probe 实测兜底。 */
  lastPromptAnchorReal: boolean;
  touched: boolean;
  /** 双写时文件未落盘(内核懒建)而降级的模型偏好——该进程首个 messageStart
   *  (文件必已落盘)补写清账(docs/design/session-model-config.md §4.5)。 */
  pendingModelPrefs?: SessionModelPrefs;
  /** 配置依赖快照(spawn 时记录):models.json/settings.json 的 mtime。复用前校验,
   *  任一变化 → 进程过期重建(docs/design/models-config-reload.md)。 */
  configSnapshot: ConfigSnapshotEntry[];
  /** 会话级角色卡(createProc 存;switchKernel 重注入 systemPromptTexts 用,§9.1)。 */
  role?: SessionRole;
  /** 最近一次 setModel 的中立模型引用(档位分类)。跨切换模型中立化的持久载体,
   *  不读 latestSnapshot(dsh 无快照面恒 null,§9.3/§11)。 */
  lastModelRef: NeutralModelRef | null;
  /** 本进程创建时绑定的模型(provider/modelId;spawn 握手值)。热切内核(pi、补面后的 dsh)
   *  运行时切模后它不再代表生效值(生效值看 effectiveModel,docs/model-switching.md §11.3)——
   *  它只剩两个用途:ensureForSend 的失配比对输入、未热切过时的账本兜底。 */
  model?: { provider: string; modelId: string };
  /** 当前「生效模型」(provider/modelId/kernel)。与 model 不同:setModel 运行时切模后 model 仍
   *  是 spawn 时定死值(pi 切模不重启),effectiveModel 则随 setModel 更新——它是「本条消息
   *  由哪个模型生成」的权威,assistant 消息落盘/广播时据此注入 message.model。 */
  effectiveModel?: { provider: string; modelId: string; kernel: KernelId };
  /** 当前活跃 lineage 的中立 id(追加新 entry 的目标)。初始 = neutralSessionId(根 lineage),
   *  fork 后 = 新分支 lineage 的 id(neutral-session-first §9)。 */
  activeLineageId: string;
  /** 内核当前物化的 lineage id(§kernel-forkless §15):单线执行器一次只跑一条 lineage。
   *  与 activeLineageId 不等 = 活跃 lineage 未物化(fork 后)→ prompt 先 seed。 */
  materializedLineageId: string;
}

export class SessionStore implements
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, PiExtensions, BashApi, SessionStoreForRestart
{
  /** pi 内核专属扩展面(§7.6):SessionStore 聚合实现全部 pi 专属命令,经此面向插件暴露。
   *  插件经 capabilities.piExtension 探测「有则用、无则降级」。 */
  get pi(): PiExtensions {
    return this;
  }
  /** 会话 → 内核 → 进程条目。key = sessionPath(历史会话)或 `new:${cwd}`(新会话,未落盘)。
   *  进程按需起(发消息选模型时才起,§kernel-follows-model):内核是模型的派生量,
   *  选模之前不起任何内核进程——历史教训:预热双内核会把会话绑进「预热时随机定的中立
   *  会话 + 首注册内核」,用户选的模型被旧预热进程截胡(选 dsh 却路由到 pi 的根因)。 */
  private procs = new Map<string, Map<KernelId, SessionProc>>();
  /** session busy 状态:agentStart/autoRetryStart 设 true、agentSettled/autoRetryEnd(success=false) 设 false(§6.6)。 */
  private busyStates = new Map<string, boolean>();
  private factory: BackendFactory;
  /** 视图流监听器(onEvent):只收激活会话的事件,渲染层不需关心多进程归属。 */
  private listeners = new Set<(event: SessionEvent) => void>();
  /** 运维流监听器:收全部会话的事件并带 sessionKey(restart-coordinator 等按 key 订阅)。 */
  private keyedListeners = new Set<(event: SessionEvent, sessionKey: string) => void>();
  /** Session Bus 上行帧监听器($bus 帧 + 来源 key;路由器在 bootstrap 订阅)。 */
  private busFrameListeners = new Set<(frame: Record<string, unknown>, sessionKey: string) => void>();
  private kernelListeners = new Set<(event: KernelEvent) => void>();
  private questionListeners = new Set<(req: QuestionRequestEvent) => void>();
  private snapshotListeners = new Set<(snapshot: SyncSnapshot) => void>();
  /** 中立层变更通知监听器(session-single-source §3.2):写口每写一次产一条回执。 */
  private neutralListeners = new Set<(change: NeutralChange) => void>();
  /** 最近一次 sync 的投影基线(renderer 增量应用的起点)。 */
  latestSnapshot: SyncSnapshot | null = null;

  /** 当前激活会话的 key(setContext 设);发送路径的目标。 */
  private activeCwd: string | null = null;
  private activeSessionPath: string | null = null;
  /** 激活会话在 procs 里的 key(初始 = sessionPath 或 new:${cwd})。fork/clone 对账时
   *  随 rekeyProc 迁到新会话文件路径(事件闭包按 proc.key 路由,迁移不丢转发)。 */
  private activeProcKey: string = "";
  /** 跨内核切换进行中标记(§15.1 互斥):切换期间再点切 / 发消息 / setContext 由它拦截。 */
  private switching = false;
  /** 跨内核切换暂缓开关(§3.2):false = switchKernel 入口 gate 抛错,七步编排原样保留。
   *  未来放开切换 = 置 true(或删掉字段 + gate 判断)。 */
  private switchKernelEnabled = false;
  /** 当前激活内核(多槽位并存):空会话 null(未选模型);setModel 选模型时设。
   *  一个会话 pi/dsh 进程槽位并存,activeKernel 只决定「哪个槽位参与会话流」,
   *  不是「替换另一个槽位」。 */
  private activeKernel: KernelId | null = null;

  /** factory 由 shell 在启动期注入(依赖倒置);不在此 new gateway 具体类。 */
  /** agentDir 由 shell 注入(pi 内核会话根目录);application 不直读 process.env.HOME(依赖倒置)。 */
  private agentDir: string;
  /** 系统 prompt 文件路径列表,spawn 时拉取(由 registry.systemPromptPaths() 注入,
   *  插件贡献的 systemPrompts 槽项;插件卸载 → 贡献移除 → 不注入);空数组不拼 argv。 */
  private getSystemPromptPaths: () => string[];
  /** 目录/CRUD 工厂(依赖倒置,圆心契约):目录/CRUD 是内核专属存储操作,壳经工厂拿
   *  SessionCatalog 委托,不读任何内核存储(§7.5 不变量 #1)。 */
  private catalogFactory: SessionCatalogFactory;
  /** 中立会话树持久化存储(可选;缺省不持久化)。session-neutral-layer.md ① 的落地载体。 */
  private neutralStore: NeutralSessionStore | null;
  /** 收藏快照目录解析器(cwd → 项目级 bookmarks 目录);null = 快照收藏未启用。 */
  private bookmarkDir: ((cwd: string) => string) | null;
  /** 收藏快照存储懒缓存(cwd → store)。bookmarkDir 变化时缓存项随 cwd 隔离。 */
  private bookmarkStores = new Map<string, BookmarkSnapshotStore>();
  /** 模型清单(可选;缺省不降级)。session-neutral-layer.md ④ 的落地载体:切内核模型显式降级。 */
  private modelCatalog: ModelCatalog | null;
  /** 挂起提问存储(ask 续问,ask-design §4.3;可选,缺省退回瞬态行为)。 */
  private questionStore: PendingQuestionStore | null;
  /** 续路补投在飞去重(水合补投与作答竞态护栏)。 */
  private resumingQuestions = new Set<string>();
  constructor(
    factory: BackendFactory,
    catalogFactory: SessionCatalogFactory,
    agentDir: string,
    getSystemPromptPaths?: () => string[],
    neutralStore?: NeutralSessionStore,
    modelCatalog?: ModelCatalog,
    bookmarkDir?: (cwd: string) => string,
    questionStore?: PendingQuestionStore,
  ) {
    this.factory = factory;
    this.catalogFactory = catalogFactory;
    this.agentDir = agentDir;
    this.getSystemPromptPaths = getSystemPromptPaths ?? (() => []);
    this.neutralStore = neutralStore ?? null;
    this.modelCatalog = modelCatalog ?? null;
    this.bookmarkDir = bookmarkDir ?? null;
    this.questionStore = questionStore ?? null;
  }

  /** 目录/CRUD 按内核懒缓存(§1.5 多内核默认):统一经 Map<KernelId, SessionCatalog> 查,
   *  不在调用方写 kernel === "pi" 二选一。pi/dsh 别名保留给已有文件类方法。 */
  private catalogCache = new Map<KernelId, SessionCatalog>();
  private catalogFor(kernel: KernelId): SessionCatalog {
    let c = this.catalogCache.get(kernel);
    if (!c) {
      c = this.catalogFactory.create(kernel);
      this.catalogCache.set(kernel, c);
    }
    return c;
  }
  private get catalog(): SessionCatalog {
    return this.catalogFor("pi");
  }
  private get dshCatalog(): SessionCatalog {
    return this.catalogFor("dsh");
  }

  /** pi 会话文件路径(this.catalog 恒为 pi 文件型目录,newSessionId 必返回路径;null 只在
   *  惰性创建会话的内核出现,pi 文件操作不该碰到)。 */
  private newPiSessionPath(cwd: string): string {
    const path = this.catalog.newSessionId(cwd);
    if (path == null) throw new Error("当前内核未预生成会话文件路径");
    return path;
  }

  /** 某会话的进程是否活着。传 kernel 查指定内核;不传查 activeKernel;
   *  activeKernel 未定(null)时查任意内核(会话级「有没有活进程」)。 */
  private isAlive(key: string, kernel?: KernelId): boolean {
    const kernels = this.procs.get(key);
    if (!kernels) return false;
    if (kernel) return kernels.get(kernel)?.backend.alive ?? false;
    if (this.activeKernel) return kernels.get(this.activeKernel)?.backend.alive ?? false;
    return [...kernels.values()].some((p) => p.backend.alive);
  }

  get alive(): boolean {
    return this.activeProcKey ? this.isAlive(this.activeProcKey) : false;
  }

  /** 激活会话的 key(= activeProcKey)。 */
  private get activeKey(): string {
    return this.activeProcKey;
  }

  /** 激活会话的、激活内核的进程(没起返回 undefined;调用方先 ensure)。 */
  private activeProc(): SessionProc | undefined {
    if (!this.activeKernel) return undefined;
    return this.procs.get(this.activeKey)?.get(this.activeKernel);
  }

  /** 全部会话的全部内核进程(扁平化,多槽位下跨会话/跨内核扫描用)。 */
  private allProcs(): SessionProc[] {
    return [...this.procs.values()].flatMap((kernels) => [...kernels.values()]);
  }

  /** path → proc key 寻址(根因修复,勿回退):fork/clone 对账经 rekeyProc 把条目迁到
   *  新文件路径(key === boundSessionPath),正常态按路径直接命中;兜底扫描 bound 防
   *  迁移时序差。找不到返回路径本身(作为新进程的待用 key)。历史教训:key 不迁移时,
   *  重开 fork 源会话会经 procs.get(源路径) 撞上已迁走的进程——误判存活、sync 推错
   *  会话基线、warmup 不再为源会话起真进程,retry 拿源会话 entryId 去 fork 迁移进程,
   *  内核报 "Invalid entry ID for forking"。 */
  private resolveProcKey(sessionPath: string): string {
    for (const [key, kernels] of this.procs) {
      for (const proc of kernels.values()) {
        if (proc.boundSessionPath === sessionPath) return key;
      }
    }
    return sessionPath;
  }

  /** 记录发送路径的上下文(cwd + 会话文件,null=新会话)。不动进程,只设激活。
   *  若激活会话 pi 活着 → resync 推基线(切回正在跑的会话拿实时状态);
   *  没活 → 清基线(renderer 走文件读或等 prompt 时起)。 */
  setContext(cwd: string, sessionPath: string | null): void {
    // 回收"未发送过消息的新会话壳"(根因修复,勿回退):
    // pref flush(setModel/setThinkingLevel 走 ensureForSend)会为本 cwd 起一个新会话进程,
    // pi 懒建会话文件——未 prompt 前 boundSessionPath 指向的文件尚不存在,进程是空壳。
    // 此前此处的回收分支查 `new:${cwd}` key,而 ensureForSend 把进程存在生成的会话路径
    // key 下(从不存 new:cwd),分支永不命中 → 每次新对话首发泄漏一个孤儿 pi(实测:一次
    // 发送起两个进程, pref flush 那个永不回收)。改为按重置前的激活 proc 判定:未发送过
    // 消息(touched=false)且活着 → stop+delete;有内容的会话进程不动(多会话并存)。
    const prevKey = this.activeProcKey;
    this.activeCwd = cwd;
    this.activeSessionPath = sessionPath;
    // 路径→key 经 resolveProcKey(fork/clone 对账已 rekey,正常态 key === 路径)
    const key = sessionPath ? this.resolveProcKey(sessionPath) : (cwd ? `new:${cwd}` : "");
    this.activeProcKey = key;
    if (prevKey && prevKey !== key) {
      const prevKernels = this.procs.get(prevKey);
      if (prevKernels) {
        const prevProcs = [...prevKernels.values()];
        if (prevProcs.every((p) => !p.touched) && prevProcs.some((p) => p.backend.alive)) {
          void Promise.all(prevProcs.map((p) => p.backend.stop().catch(() => {}))).then(() => { this.procs.delete(prevKey); });
        }
      }
    }
    if (this.isAlive(key)) {
      // 激活会话 pi 活着:resync 推基线(切回流式中的会话拿实时状态)
      void this.sync().catch(() => {});
    } else {
      // 没活:清基线,renderer 走文件读
      this.latestSnapshot = null;
    }
    // 激活即推给 renderer 水合 useUiStore.currentSessionPath(根因修复,勿回退):
    // 内核 session_start 是纯扩展事件(_sessionStartEvent 只经 _extensionRunner.emit
    // 走扩展通道;AgentSessionEvent 联合不含 sessionStart;RPC stdout 永不见
    // session_start),renderer 永远等不到内核推出该事件。此前打开历史会话靠
    // sessions-list 手动补写 currentSessionPath——隐式契约,第二个忘记补写的入口
    // 就会导致"视图里有会话内容、发送却走了新会话分支"。修复:main 激活会话时
    // 主动推 synthetic sessionStart,当前会话流的真相源单一在 main。
    if (sessionPath) {
      this.dispatch(key, { type: "sessionStart", sessionFile: sessionPath });
    }
    // 提问水合(ask-design §8.1):重投 pending(卡片复活)+ 补投 answered 未 delivered(答案必达)。
    this.rehydrateQuestions();
  }

  /** fs:project IPC 圈禁的锚点(当前激活项目根;shell 的 IPC 边界从这里取)。 */
  getActiveCwd(): string | null {
    return this.activeCwd;
  }

  /** 启动激活会话的 pi(按需;sessionPath 给定时 spawn --session 续上下文)。
   *  不杀其他会话的进程(多会话并存)。完成后 sync 广播基线。
   *  role:会话级角色卡,内联作 --append-system-prompt 的值注入系统上下文——
   *  "拉起 pi + 设系统上下文"两步合一,主会话与子会话同一条路径。 */
  async start(cwd: string, sessionPath?: string, role?: SessionRole, skipResolve = false, kernel?: KernelId, provider?: string, model?: string): Promise<void> {
    this.activeCwd = cwd;
    this.activeSessionPath = sessionPath ?? null;
    // 路径→key 经 resolveProcKey(fork/clone 对账已 rekey,正常态 key === 路径)
    const key = sessionPath ? this.resolveProcKey(sessionPath) : `new:${cwd}`;
    this.activeProcKey = key;
    // skipResolve:forkFromSession 的中间副本是临时新文件,不需读回;resolve 的 await 会破坏
    // 「setContext+createProc 同步段」竞态护栏(见 forkFromSession)。
    const ns = !skipResolve && sessionPath ? this.neutralSessionIdFromPath(sessionPath) : undefined;
    // 内核读回(§2.4):调用方显式传的优先;否则从会话归属读回——读不到即报错,不回落 pi。
    // skipResolve(fork 中间副本)不读回,调用方必须显式传 kernel(中间副本必是 pi 文件)。
    if (skipResolve && !kernel) throw new Error("无法确定会话内核：内部调用必须显式指定内核");
    const resolvedKernel = kernel ?? await this.resolveSessionKernel(sessionPath, ns);
    // 起进程即隐含「要用这个内核」:activeKernel 未定时设它(warmup 走 warmupKernel 不经此,不设)。
    if (this.activeKernel == null) this.activeKernel = resolvedKernel;
    if (this.isAlive(key, resolvedKernel)) return; // 该内核已活,不重复起
    const proc = this.createProc(key, cwd, sessionPath ?? null, false, resolvedKernel, role, ns, provider, model);
    // 多槽位并存:进程按内核存入会话槽位(不替换其他内核的进程)
    let kernels = this.procs.get(key);
    if (!kernels) { kernels = new Map(); this.procs.set(key, kernels); }
    kernels.set(resolvedKernel, proc);
    await proc.backend.start();
    // 物化标记随能力面落定(根因修复,勿回退):createProc 恒置空=惰性物化;start 后能力探测
    // 到位,按「预 seed 面」归位——pi 有预 seed(spawn 即经 --session 读文件,内容已在)标
    // 已物化(ns);dsh 无预 seed(进程空空)保持空串,首发 materializeActiveLineage 再 seed 回填。
    // 不能用 `factory.seed 有无`(生产恒有,dsh 返 null),故用能力面 capabilities.pi(§1.5)。
    proc.materializedLineageId = proc.backend.capabilities.pi ? proc.activeLineageId : "";
    // 并发护栏(根因修复,勿回退):start 的 await 窗口(spawn+waitReady,tsx dev pi 1~2s)
    // 内可能插入并发 setContext(⌘N/切目录/第二次 sendText 的 startNewChat)把
    // activeProcKey 切走。此后 sync 用 activeProc() 回查会落空抛误导性的"pi 未启动"。
    // 上下文已切或内核已切换则跳过视图同步(进程保留给多会话/多槽位并存),由调用方校验激活态。
    if (this.activeProcKey !== key || this.activeKernel !== resolvedKernel) return;
    await this.sync();
    // 能力面就绪(§7.6 push 收口):backend.start 落定后 piExtension/dshExtension 已探测,
    // 广播一次 capabilitiesChanged——renderer 订阅即到位,不再散拉式 refreshCapabilities。
    this.broadcastCapabilities(proc);
  }

  /** 由 pi 派生路径反查 neutralSessionId(§kernel-forkless §12.2):派生路径的文件名就是 ns
   *  (piDerivedSessionPath = <bucket>/<ns>.jsonl)。旧随机 stamp 文件文件名不含 ns → 返回 null
   *  (迁移前文件,list 读中立层已不可见)。同步:不再读/写内核头(§6 去反向 smell)。 */
  private neutralSessionIdFromPath(sessionPath: string): string | undefined {
    return basename(sessionPath, ".jsonl") || undefined;
  }

  /** 归一会话标识(§kernel-forkless §32 契约单源):中立 ns 与投影路径双形态都收。
   *  basename 对裸 ns 是恒等,对投影路径(<bucket>/<rootLineageId>.jsonl)提出 rootLineageId(=ns)。
   *  凡「按标识查中立层」的公开方法统一经此入参——调用方传哪个形态都对,
   *  不再有「只能传 ns」的隐性契约(此前 openSession 裸 get 传投影路径静默查空)。 */
  private resolveNs(sessionId: string): string {
    return this.neutralSessionIdFromPath(sessionId) ?? sessionId;
  }

  /** 读回会话内核(§2.4):中立 header.kernel > model 域 kernel > 会话头 custom.kernel。
   *  目标是「重开历史 dsh 会话不起成 pi」,不建完整的会话内核恢复系统。
   *  ns 由调用方 resolve 后传入(避免重复读);skipResolve 场景(fork 中间副本)ns 为 undefined。
   *  读不到即报错——内核 = 模型的派生量,查无实据时不静默落 pi(§kernel-follows-model)。 */
  private async resolveSessionKernel(sessionPath: string | null | undefined, ns?: string): Promise<KernelId> {
    if (ns) {
      const neutral = this.neutralStore?.get(ns);
      if (neutral?.header?.kernel) return neutral.header.kernel;
    }
    if (!sessionPath) throw new Error("无法确定会话内核：新会话需先选择模型");
    const custom = await this.catalog.readCustom(sessionPath).catch(() => null);
    const prefs = parseSessionModelPrefs(custom ?? undefined);
    if (prefs?.kernel) return prefs.kernel;
    if (custom?.["kernel"] === "pi" || custom?.["kernel"] === "dsh") return custom["kernel"] as KernelId;
    throw new Error("无法确定会话内核：会话头未记录内核归属，请先选择模型");
  }

  /** 创建并装配一个 pi 进程条目:backend + 全套事件绑定。
   *  start/restart 唯一装配入口——此前 restart 另抄一份丢了 onQuestion/onProcessExit,
   *  重启后的会话收不到扩展 UI 请求、进程退出静默(根因:同一逻辑两处拷贝)。
   *  ephemeral:临时会话(测试不落盘);中性字段经 BackendFactory 交内核实现翻译
   *  (pi=--no-session,dsh=临时 DSH_SESSION_ROOT),application 不拼内核专属 args。
   *  neutralSessionId:调用方在 createProc 之前 resolve(读会话头恢复);缺省新生成 UUID。 */

  private createProc(key: string, cwd: string, sessionPath: string | null, ephemeral = false, kernel: KernelId, role?: SessionRole, neutralSessionId?: string, provider?: string, model?: string): SessionProc {
    // 中立会话主键:调用方 resolve(读会话头恢复)或新生成 UUID;映射表记录本内核绑定。
    const ns = neutralSessionId ?? randomUUID();
    // 中立层成为唯一真相源(§kernel-forkless §27 阶段 D):会话创建即写空中立会话,
    // 不等到首条消息——「开始但未发言」的会话也进中立层,list 读中立层才不漏。
    if (this.neutralStore && !ephemeral && !this.neutralStore.get(ns)) {
      const empty = emptyNeutralSession(ns, { kernel, cwd, createdAt: new Date().toISOString() });
      this.putNeutral(empty, { ns, kind: "session", session: empty });
    }
    const backend = this.factory.create({
      cwd,
      agentDir: this.agentDir,
      kernel,
      // 内核私有会话 id 派生见 kernelSessionId(会话标识中性化收口点 §session-neutral-layer §5.3)。
      neutralSessionId: ns,
      // 模型偏好(六条意图 setModel 的中性输入):dsh 在 initialize 握手即用,pi 经 setModel 命令。
      // 缺省 = 内核工厂的兜底默认(pi models.json / dsh agent-default-model)。
      provider,
      model,
      systemPromptPaths: this.getSystemPromptPaths(),
      systemPromptTexts: role ? [roleToPrompt(role)] : undefined,
      ephemeral,
    });
    // 内核侧会话标识归 backend.sessionId(pi=路径,dsh=中立主键 ns,seed 后重绑);壳不自拼内核会话 id。
    const proc: SessionProc = { backend, kernel, neutralSessionId: ns, nonce: randomUUID(), cwd, key, boundSessionPath: sessionPath, genStartMs: null, lastTps: null, roundOut: 0, roundGenSec: 0, turn: zeroTurnUsage(), lastTurn: null, turns: 0, steps: 0, lastPromptAnchorReal: false, touched: false, configSnapshot: this.captureConfigSnapshot(backend.configDepPaths ?? []), role, lastModelRef: null, model: provider && model ? { provider, modelId: model } : undefined, effectiveModel: provider && model ? { provider, modelId: model, kernel } : undefined, activeLineageId: ns,
      // 物化标记(session-single-source §4.4):一律置空=惰性物化——新进程尚未把活跃 lineage 灌进内核。
      // 此前用 `this.factory.seed ? ns : ""` 判「有无预 seed 面」,但生产 factory.seed 恒定义
      // (dsh 返回 null 表示走 RPC seed),`factory.seed` 恒真 → dsh 也标 ns=已物化 → 重开历史
      // dsh 会话的 seed 回填被 materializeActiveLineage 提前 return 跳过,历史丢失(实弹/测试
      // 都用无 seed 工厂掩盖了)。改惰性后由 materializeActiveLineage 按能力面区分:
      // RPC-seed 内核(dsh)在现进程 seed;预 seed 内核(pi)先写文件再 spawn。
      materializedLineageId: "" };
    this.bindProcEvents(proc);
    return proc;
  }

  /** 绑定进程条目的事件通道(createProc 与跨内核切换重绑共用)。
   *  中性事件流(backend.onEvent)总是绑;pi 专属通道($bus / Extension UI / 进程退出)
   *  经类型守卫只绑 pi 后端——dsh 后端不接这些线(缺面)。 */
  private bindProcEvents(proc: SessionProc): void {
    // 闭包按 proc.key 路由(不捕获创建期 key):fork/clone 对账 rekeyProc 迁移条目后,
    // 事件仍按当前 key 进 dispatch,归属不漂。
    proc.backend.onEvent((event) => this.dispatch(proc.key, event, proc.kernel));
    // dsh 懒探测的缺面回调:发现新缺面方法时广播降级事件(§dsh-capability-gate §4)。
    const dsh = proc.backend.capabilities.dsh;
    if (dsh) {
      dsh.onMissing = (method) => {
        this.dispatchKernel({ kind: "capabilityDegraded", sessionKey: proc.key, method });
      };
    }
    const pi = proc.backend.capabilities.pi as PiBackendExtensions | undefined;
    if (!pi) return;
    pi.onBusFrame((frame) => {
      for (const cb of this.busFrameListeners) {
        try {
          cb(frame, proc.key);
        } catch (err) { console.error("[session-store] bus 帧监听器抛错已隔离:", err); }
      }
    });
    pi.onQuestion((req) => {
      this.mintQuestionRecord(proc, req); // 先落账(准入失败的帧只投不落,ask-design §4.3)
      const questionEvent: QuestionRequestEvent = {
        kind: "question",
        requestId: req.requestId,
        sessionKey: proc.key,
        questions: req.questions,
      };
      this.dispatchKernel(questionEvent);
      // 视图流仅激活会话(与 dispatch 的视图流过滤同源):提问不跨 session 投给渲染层。
      if (proc.key !== this.activeProcKey) return;
      for (const cb of this.questionListeners) {
        try { cb(questionEvent); } catch (err) { console.error("[session-store] 提问监听器抛错已隔离:", err); }
      }
    });
    pi.onProcessExit = (exit, expected) => {
      this.dispatchKernel({
        kind: "processExit",
        code: exit.code, signal: exit.signal, expected,
        stderr: pi.stderr.slice(-500), sessionKey: proc.key,
      });
    };
  }

  /** fork/clone 对账:进程条目从旧 key 迁到新会话文件路径,恢复"key === boundSessionPath"
   *  不变量(根因修复,勿回退为 key 不动):key 留在 fork 源路径时,重开源会话的
   *  setContext/warmup/start 会经 procs.get(源路径) 撞上已迁走的进程——误判"源会话
   *  活着"、sync 推出错会话基线、源会话永不起真进程;视图拿着源会话 entryId 去 fork
   *  迁移进程,内核报 "Invalid entry ID for forking"。迁移含 busyStates 账与激活 key。 */
  private rekeyProc(proc: SessionProc, newPath: string): void {
    const oldKey = proc.key;
    proc.boundSessionPath = newPath;
    if (oldKey === newPath) return;
    const kernels = this.procs.get(oldKey);
    if (kernels) {
      this.procs.delete(oldKey);
      this.procs.set(newPath, kernels);
      for (const p of kernels.values()) {
        p.key = newPath;
        if (p.boundSessionPath) p.boundSessionPath = newPath;
      }
    }
    const busy = this.busyStates.get(oldKey);
    if (busy !== undefined) {
      this.busyStates.set(newPath, busy);
      this.busyStates.delete(oldKey);
    }
    if (this.activeProcKey === oldKey) this.activeProcKey = newPath;
  }

  /** 捕获内核进程的配置依赖快照(paths 由后端 configDepPaths 提供,壳不硬编码内核文件名)。
   *  文件不存在记 -1(存在性变化同样视为配置变更)。 */
  private captureConfigSnapshot(paths: string[]): ConfigSnapshotEntry[] {
    return paths.map((p) => {
      try {
        return { path: p, mtimeMs: statSync(p).mtimeMs };
      } catch {
        return { path: p, mtimeMs: -1 };
      }
    });
  }

  /** 配置依赖是否过期:重读快照逐项对比,任一 mtime 变化 → 进程需重建
   *  (内核模型快照 spawn 时定型,运行中不重读;复用旧进程 set_model 必失败)。 */
  private isConfigStale(proc: SessionProc): boolean {
    const now = this.captureConfigSnapshot(proc.backend.configDepPaths ?? []);
    if (proc.configSnapshot.length !== now.length) return true;
    return now.some((entry, i) => entry.mtimeMs !== proc.configSnapshot[i].mtimeMs);
  }

  /** 停指定会话的进程(不传 = 激活会话);停该会话全部内核槽位,其他会话进程不动。 */
  async stop(sessionPath?: string | null): Promise<void> {
    const key = sessionPath != null ? this.resolveProcKey(sessionPath) : this.activeKey;
    const kernels = this.procs.get(key);
    if (!kernels) return;
    await Promise.all([...kernels.values()].map((p) => p.backend.stop().catch(() => {})));
    this.procs.delete(key);
    if (key === this.activeKey) this.latestSnapshot = null;
  }

  /** 停所有会话的全部进程(应用退出兜底)。 */
  async stopAll(): Promise<void> {
    const ps = [...this.procs.values()].flatMap((kernels) => [...kernels.values()].map((p) => p.backend.stop().catch(() => {})));
    await Promise.all(ps);
    this.procs.clear();
    this.latestSnapshot = null;
  }

  /**
   * 发送前的进程保证:激活会话的目标内核进程在跑。没起 → 起;不杀其他会话进程。
   * 内核由调用方显式指定(内核=模型的派生量,§kernel-follows-model),本方法不做任何回落。
   * 新会话(activeSessionPath=null)时:
   *  - 文件型内核(pi):预生成会话文件路径(--session <path>,pi 拿不存在的文件建新会话);
   *  - 惰性内核(dsh):壳派生投影地址(新 ns 即投影地址),中立主键/水合同样落地。
   */
  private async ensureForSend(kernel: KernelId, provider?: string, model?: string): Promise<void> {
    if (!this.activeCwd) throw new Error("未选择工作目录");
    // 跨内核切换进行中(§15.2):发送/切模型都经此入口,切换中拦截,避免命中"半换"的 proc。
    if (this.switching) throw new Error("内核切换进行中,请稍后");
    // 进程复用判据:该内核进程已活、配置未过期、模型未变 → 直接复用。
    // 模型失配处理分内核:pi 支持运行时切模(稍后 backend.setModel 差量执行,不重启);
    // dsh 的模型在 initialize 握手定死——失配(含进程未记录模型的未知态)必须停旧起新,
    // 否则用户选的模型被旧进程的握手模型截胡(选 A 模型却以 B 模型跑的根因)。
    const existing = this.procs.get(this.activeProcKey)?.get(kernel);
    const modelMismatch = !!(provider && model && (!existing?.model
      || existing.model.provider !== provider || existing.model.modelId !== model));
    // 模型失配的重启判据(docs/model-switching.md §11.2:两根正交的轴,勿回退为读
    // capabilities.pi——那是「pi 扩展面」的桶探测,不是「能不能热切」的轴):
    // ① 运行时切模轴缺面(后端自报 supportsRuntimeSetModel=false,如 dsh 旧运行时缺
    //    session/setModel)→ 只能停旧起新;
    // ② 未物化的惰性内核会话(从没发过消息,服务端还没有会话可热切)→ 握手是唯一
    //    定模点,重建零代价。惰性判据复用 catalog.newSessionId==null(文件型内核
    //    预生成路径返非 null,惰性内核返 null)。
    const lazyKernel = existing != null
      && this.catalogFor(kernel).newSessionId(this.activeCwd) == null;
    const needsRestart = modelMismatch && !!existing && (
      !existing.backend.supportsRuntimeSetModel
      || (!existing.touched && lazyKernel)
    );
    if (existing && existing.backend.alive && !this.isConfigStale(existing) && !needsRestart) return;
    // 配置过期 / 模型失配需重启:只停该内核旧进程,重起一个带新模型。
    if (existing && existing.backend.alive) {
      await existing.backend.stop()
        .catch((e) => console.warn("[session-store] 内核配置/模型变更停进程失败,下次发起再校验:", e));
      this.procs.get(this.activeProcKey)?.delete(kernel);
    }
    // 新会话:经目标内核 catalog 问「要不要预生成会话标识」(pi=新文件路径,文件名即新 ns)。
    let sessionPath = this.activeSessionPath ?? undefined;
    if (!sessionPath) {
      const catalog = this.catalogFactory.create(kernel);
      const generated = catalog.newSessionId(this.activeCwd);
      // 惰性内核(无文件,如 dsh)由壳派生投影地址:新 ns 即投影地址(与中立主键同源),
      // 保证 start 的 ns 反查(路径 basename)、renderer 水合、列表投影路径三者一致。
      sessionPath = generated ?? catalog.projectionPath(this.activeCwd, randomUUID());
      this.activeSessionPath = sessionPath;
      // 生成即水合(根因修复,勿回退):立即推 synthetic sessionStart 让 renderer 写入
      // useUiStore.currentSessionPath。此前水合只在 prompt 发送成功后做,而 pref flush
      // (setModel/setThinkingLevel)先于 prompt 走 ensureForSend 起了进程却没水合 →
      // sendText 仍判 currentSessionPath=null → 二次 startNewChat → setContext(cwd,null)
      // 把 activeProcKey 重置走、prompt 的 ensureForSend 再 spawn 第二个进程(双 spawn,
      // pref flush 那个成孤儿)。水合前置后 sendText 跳过 startNewChat,prompt 复用同一进程。
      this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: sessionPath });
    }
    await this.start(this.activeCwd, sessionPath, undefined, false, kernel, provider, model);
    // 并发收尾校验:start 的 await 窗口内若并发 setContext 把 activeSessionPath 换走,
    // 发送目标已失效——给准确错误,而非让后续 activeProc() 落空抛误导性的"pi 未启动"。
    if (sessionPath && this.activeSessionPath !== sessionPath) throw new Error("发送期间会话上下文已切换,请重试");
  }



  // ---- SessionsApi 文件类方法:委托给 session-scanner(纯文件操作,不启 pi 进程)----
  // SessionStore 作为 SessionsApi 的聚合实现点,文件操作委托同模块 scanner 函数。
  // 进程类操作(start/stop/sync 等)由本类直接实现,文件类操作(list/openSession/...)委托。
  // 这样 SessionsApi 契约名副其实,IPC 边界可统一经 SessionStore 调用(消除 shell 直连 scanner 的散点)。
  async list(cwd: string): Promise<SessionInfo[]> {
    // §kernel-forkless §27 阶段 D:会话列表的唯一源是壳自己的中立层,不读内核存储。
    // path 是投影地址(由 lineageId 派生,§12.2),不再做主键。
    const sessions = this.neutralStore?.listByCwd(cwd) ?? [];
    return sessions.map((s) => this.neutralToSessionInfo(s, cwd));
  }

  /** 解析会话可打开的原始文件地址(§7.6:原始文件位置是内核专属知识,经各内核
   *  SessionCatalog.rawFilePath 解析,不让调用方拿 SessionInfo.path 投影地址硬猜)。
   *  - desktop = 中立层会话文件(壳自己的存储,<数据根>/sessions/<ns>.json);
   *  - kernel = 内核原始文件(投影文件存在才返回;临时会话/迁移前旧文件 → null)。
   *  会话不存在 / 无中立层时两项皆 null,调用方显式降级,不静默。 */
  async rawFilePaths(sessionId: string): Promise<SessionRawFilePaths> {
    const session = this.neutralStore?.get(this.resolveNs(sessionId));
    if (!session) return { desktop: null, kernel: null };
    const ns = session.neutralSessionId;
    const desktop = this.neutralStore!.filePathOf(ns);
    const rootLineageId = session.lineages.find((l) => l.fork === null)?.lineageId ?? ns;
    const catalog = this.catalogFor(session.header.kernel);
    const kernel = catalog.rawFilePath(session.header.cwd, rootLineageId);
    return { desktop: existsSync(desktop) ? desktop : null, kernel };
  }

  /** 中立会话 → SessionInfo(§kernel-forkless §32):neutralSessionId 是主键,
   *  path 是投影地址(投影线索)。列表行字段全来自中立 header。 */
  private neutralToSessionInfo(s: NeutralSession, cwd: string): SessionInfo {
    const rootLineageId = s.lineages.find((l) => l.fork === null)?.lineageId ?? s.neutralSessionId;
    const catalog = this.catalogFor(s.header.kernel);
    // 读时兜底回填(问题 B 收尾):历史会话的中立 header 缺 lastMessage/lastEntryId/updatedAt
    // (阶段 D 之前写入的旧数据),从现有 entries 现算——不依赖内核存储,列表即刻自愈。
    const derived = (s.header.lastMessage === undefined || s.header.lastEntryId === undefined || s.header.updatedAt === undefined)
      ? derivedHeaderFromSession(s)
      : {};
    return {
      neutralSessionId: s.neutralSessionId,
      path: catalog.projectionPath(cwd, rootLineageId),
      id: rootLineageId,
      cwd: s.header.cwd,
      name: s.header.name,
      created: s.header.createdAt,
      modified: s.header.updatedAt ?? derived.updatedAt ?? s.header.createdAt,
      lastMessage: s.header.lastMessage ?? derived.lastMessage,
      lastEntryId: s.header.lastEntryId ?? derived.lastEntryId,
      pinned: s.header.pinned,
      archived: s.header.archived,
      custom: s.header.custom,
    };
  }
  async openSession(id: string): Promise<SessionDetail | null> {
    // §kernel-forkless §27 阶段 D:打开会话读中立层(按 neutralSessionId),不读内核存储。
    // 入参经 resolveNs 归一——中立 ns 与投影路径双形态都收(调用方不再依赖「只能传 ns」)。
    const session = this.neutralStore?.get(this.resolveNs(id));
    if (!session) return null;
    const info = this.neutralToSessionInfo(session, session.header.cwd);
    // 展示元数据(图)随 entry.display 在中立层,合到 message.__image(neutral-first §4)。
    // 去重(resync 同款 deduplicateAdjacent):内核偶发重复写入时 refresh 与快照口径一致,不多一条。
    const messages = deduplicateAdjacent(lineageContent(session, session.neutralSessionId).map((e) =>
      e.display?.image ? ({ ...e.message, __image: e.display.image } as NeutralMessage) : e.message,
    ));
    // stats/modelEvidence 是文件扫描基线(pi 专属),中立层无此口径 → null/缺省,
    // 活会话 RPC 真值到达后覆盖(与「文件读即基线」同一语义,只是基线现在空)。
    return { info, messages, stats: null };
  }

  /** 双写中立 header(§kernel-forkless §27 阶段 D):rename/updateHeader/命名下沉内核的同时,
   *  把列表行字段(name/pinned/archived/custom)写进中立层——中立层是唯一真相源。
   *  只应用显式定义的字段:undefined 字段不覆盖——此前 {name: undefined, pinned: undefined}
   *  直接 spread 会把已有 name/pinned/custom 抹成 undefined,JSON.stringify 再丢键,归档/置顶一次就丢名。 */
  private async writeNeutralHeader(sessionPath: string, patch: Partial<NeutralSessionHeader>): Promise<void> {
    if (!this.neutralStore) return;
    const ns = this.neutralSessionIdFromPath(sessionPath);
    if (!ns) return;
    const session = this.neutralStore.get(ns);
    if (!session) return;
    const header: NeutralSessionHeader = { ...session.header };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (header as unknown as Record<string, unknown>)[k] = v;
    }
    this.putNeutral({ ...session, header }, { ns, kind: "header", header });
  }

  /** 列表行字段投影回内核存储(§27 阶段 D 双写第二写)。中立层是真相源,内核写是投影:
   *  按会话内核归属路由(不再写死 pi),失败不阻断——文件缺失/内核缺面/旧命名不匹配
   *  都不该让归档/置顶/改名失效(此前 pi 投影因 `<ns>.jsonl` 派生路径与 pi 实际
   *  `<stamp>_<id>.jsonl` 文件名不匹配而抛「会话文件不存在」,把中立层写整个吞掉)。 */
  private async projectHeaderToKernel(sessionPath: string, patch: HeaderPatch): Promise<void> {
    const ns = this.neutralSessionIdFromPath(sessionPath);
    const kernel: KernelId = (ns && this.neutralStore?.get(ns)?.header.kernel) || "pi";
    const catalog = this.catalogFor(kernel);
    try {
      // 名字下沉:dsh 的 updateHeader 面不含 name,走 session/rename;pi 的 rename 就是
      // updateHeader({name}) 的 append session_info,统一走 rename 保持一处写。
      if (patch.name != null) await catalog.rename(sessionPath, patch.name);
      const rest = { ...patch };
      delete rest.name;
      if (Object.keys(rest).length > 0) await catalog.updateHeader(sessionPath, rest);
    } catch {
      // 投影失败不阻断——中立层才是真相源(§7.5 不变量 #1)。
    }
  }

  async renameSession(sessionPath: string, name: string): Promise<void> {
    if (name && sessionPath === this.activeSessionPath && this.alive) {
      const proc = this.activeProc()!;
      await proc.backend.setSessionName(name);
      this.dispatchRenameDivider(name);
    } else {
      await this.projectHeaderToKernel(sessionPath, { name });
    }
    await this.writeNeutralHeader(sessionPath, { name });
  }

  /** 分隔线条目即时进视图流(根因:pi 的 entry_appended 补丁只覆盖 message 持久化路径,
   *  model_change/thinking_level_change/session_info 条目都不发射——这些分隔线此前只在
   *  刷新后补现,违反「刷新前后一致」)。
   *  双落点(根因修复,勿回退):
   *   ① 视图流(listeners 直投)——即时可见;
   *   ② 中立层(syncNeutralEntry)——持久化,刷新/冷开不丢。此前只投视图流,dsh 无内核
   *    会话文件兜底,刷新后分隔线全灭(「dsh 会话内容比 pi 少」的根因之一);pi 侧真身
   *    在内核 JSONL,中立层重建(snapshotNeutralSession 全量 put)会覆盖合成条目,不撞双份。 */
  private dispatchViewDivider(entry: Record<string, unknown>): void {
    if (!this.activeProcKey) return;
    const event: SessionEvent = {
      type: "entryAppended",
      entry: { id: `div-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: new Date().toISOString(), ...entry },
    };
    for (const cb of this.listeners) {
      try { cb(event); } catch (err) { console.error("[session-store] 分隔线投递失败:", err); }
    }
    const proc = this.activeProc();
    if (proc) this.syncNeutralEntry(proc, event);
  }

  /** 重命名分隔线即时进视图流(调用点语义化包装)。 */
  private dispatchRenameDivider(name: string): void {
    this.dispatchViewDivider({ type: "session_info", name });
  }
  async updateHeader(sessionPath: string, patch: HeaderPatch): Promise<void> {
    if (patch.name && sessionPath === this.activeSessionPath && this.alive) {
      const proc = this.activeProc()!;
      await proc.backend.setSessionName(patch.name);
      const rest = { ...patch };
      delete rest.name;
      if (Object.keys(rest).length > 0) await this.projectHeaderToKernel(sessionPath, rest);
    } else {
      await this.projectHeaderToKernel(sessionPath, patch);
    }
    await this.writeNeutralHeader(sessionPath, {
      name: patch.name, pinned: patch.pinned, archived: patch.archived,
      custom: patch.custom ?? undefined,
    });
  }
  async copySession(srcPath: string, targetPath: string): Promise<void> {
    this.catalog.copy(srcPath, targetPath);
  }

  /** 中立层会话注解(设计 docs/design/goal.md §8.3):只写中立层、不写内核会话文件——
   *  不进模型上下文,刷新/重开仍在;激活会话即时进视图流(custom_message 形状的
   *  entryAppended,web 侧非消息分支自然 append),后台会话静默落盘、切过去即见。
   *  渲染由 messageRenderers 槽按 role(=customType)认领。goal 控制动作留痕是首个消费方。
   *  已知边界:中立层缺失时的兜底快照重建(snapshotNeutralSession)从内核重读,注解不重建——
   *  注解是壳自有的展示数据,不参与内核投影,可接受。 */
  async annotate(sessionPath: string, customType: string, content: string): Promise<void> {
    if (!this.neutralStore) return;
    const ns = this.neutralSessionIdFromPath(sessionPath);
    if (!ns) return;
    const session = this.neutralStore.get(ns);
    if (!session) return;
    // 活跃 lineage:激活会话取 proc 的活跃 lineage,否则落根 lineage(注解挂当前可见线);
    // 中立树还没有任何 lineage 时以 ns 为根(appendNeutralEntry 缺 lineage 会自动建根)。
    const key = this.resolveProcKey(sessionPath);
    const proc = key === this.activeProcKey ? this.activeProc() : null;
    const lineageId = proc?.activeLineageId ?? session.lineages[0]?.lineageId ?? ns;
    const entry: NeutralEntry = { neutralEntryId: "", message: { role: customType, content, timestamp: Date.now() } };
    const next = appendNeutralEntryWithHeader(session, lineageId, entry, new Date().toISOString());
    // 中立层唯一写口(§session-single-source 写穿收口):持久化 + 变更通知焊死,
    // 渲染端中立镜像经 session:neutralChange 增量归约。
    const appended = next.lineages.find((l) => l.lineageId === lineageId)?.entries.at(-1);
    this.putNeutral(next, appended
      ? { ns, kind: "entry", lineageId, entry: appended, header: next.header }
      : { ns, kind: "header", header: next.header });
    // 激活会话即时进当前显示读口(双跑期:applyEvent 仍是显示源,中立镜像并行验证);
    // entry 带唯一 id(web 侧非消息分支按 id 判重优先于文本判重——同文案的两次注解
    // (如同轮两次暂停)不互相吞掉)。
    if (key === this.activeProcKey) {
      this.dispatch(key, {
        type: "entryAppended",
        entry: { type: "custom_message", customType, content, id: `note-${randomUUID()}`, timestamp: new Date().toISOString() },
      });
    }
  }
  async deleteSessions(paths: string[]): Promise<void> {
    // 活跃会话禁止删除:进程 append 会让文件复活,删了也白删(机制兜底,UI 侧另有 deletable 过滤)
    const targets = paths.filter((p) => p !== this.activeSessionPath);
    if (targets.length > 0) await this.catalog.deleteSessions(targets);
    // 级联删中立层(§27 阶段 D):中立层是唯一真相源,删会话也删中立树。
    for (const p of targets) {
      const ns = this.neutralSessionIdFromPath(p);
      if (ns) this.neutralStore?.delete(ns);
      // 级联删提问请求单(ask-design §5.3):会话没了,它的提问单不孤儿留存。
      if (ns) this.questionStore?.deleteBySession(ns);
    }
  }
  async readToolConfig(sessionPath: string): Promise<SessionToolConfig | null> {
    return this.catalog.readToolConfig(sessionPath);
  }
  async projectStats(cwd: string): Promise<ProjectStats> {
    return this.catalog.projectStats(cwd);
  }

  /** 会话 lineage 树(§kernel-forkless §22):中立层是唯一读源,内核目录降级为兜底。 */
  async getTree(sessionId: string): Promise<LineageTree> {
    // 中立层查读走 resolveNs(双形态收);兜底的 catalog.getTree 仍吃内核专属标识(原样透传)。
    const neutral = this.neutralStore?.get(this.resolveNs(sessionId));
    if (neutral) {
      return {
        rootId: neutral.lineages.find((l) => l.fork === null)?.lineageId ?? neutral.neutralSessionId,
        lineages: neutral.lineages.map((l) => ({
          id: l.lineageId,
          fork: l.fork ? { parentLineageId: l.fork.parentLineageId, boundary: l.fork.boundaryEntryId } : null,
        })),
      };
    }
    return this.catalog.getTree(sessionId);
  }

  /** 按 cwd 懒取收藏快照存储;未启用(bookmarkDir 未注入)返回 null。 */
  private bookmarkStoreFor(cwd: string): BookmarkSnapshotStore | null {
    if (!this.bookmarkDir) return null;
    let store = this.bookmarkStores.get(cwd);
    if (!store) {
      store = new BookmarkSnapshotStore(this.bookmarkDir(cwd));
      this.bookmarkStores.set(cwd, store);
    }
    return store;
  }

  /** 收藏(快照,§bookmark-snapshot-fork-unify):物化某节点完整前缀成自包含快照文件,
   *  返回快照(不同步内核)。id/label/preview 由渲染层传入并持久化。 */
  async bookmark(sessionPath: string, entryId: string, id: string, label: string, preview: string): Promise<BookmarkSnapshot> {
    const cwd = this.activeCwd;
    if (!cwd) throw new Error("无激活 cwd,无法收藏");
    if (!this.neutralStore) throw new Error("中立层未启用,无法收藏");
    const store = this.bookmarkStoreFor(cwd);
    if (!store) throw new Error("快照存储未启用,无法收藏");
    const ns = this.neutralSessionIdFromPath(sessionPath);
    if (!ns) throw new Error("无法从会话路径反查中立会话 id");
    const session = this.neutralStore.get(ns);
    if (!session) throw new Error("源会话中立树不存在");
    // 活跃 lineage(当前进程活跃分支优先;无进程回退根 lineage)——锚点所在的线性历史。
    const proc = this.activeProc();
    const lineageId = proc?.activeLineageId ?? (session.lineages.find((l) => l.fork === null)?.lineageId ?? ns);
    const prefix = materializeLineagePrefix(session, lineageId, entryId);
    if (!prefix) throw new Error("收藏锚点不在会话内容里(可能已被压缩移除)");
    const snapshot: BookmarkSnapshot = {
      version: BOOKMARK_SNAPSHOT_VERSION,
      id, label, preview,
      createdAt: new Date().toISOString(),
      sourceKernel: session.header.kernel,
      sourceNeutralSessionId: ns,
      boundaryEntryId: prefix.boundaryEntryId,
      lineage: { lineageId, entries: prefix.entries },
    };
    store.put(snapshot);
    return snapshot;
  }

  /** 发起收藏(§bookmark-snapshot-fork-unify):读快照 → seed 到目标内核 → fork 新 lineage。
   *  快照自包含(物化前缀),源会话删/压缩后仍可发起。能力探测分流(§1.5 多内核默认):
   *  目标内核经 seed 投影(pi 文件 seed / dsh RPC seed),不写 if (kernel === "pi")。 */
  async resume(snapshotId: string): Promise<string> {
    const cwd = this.activeCwd;
    if (!cwd) throw new Error("无激活 cwd,无法发起收藏");
    if (!this.neutralStore) throw new Error("中立层未启用,无法发起收藏");
    const store = this.bookmarkStoreFor(cwd);
    if (!store) throw new Error("快照存储未启用,无法发起收藏");
    const snap = store.get(snapshotId);
    if (!snap) throw new Error("快照不存在或已损坏");
    // 目标内核:当前激活内核优先;无激活内核(仅浏览历史)回退快照来源内核。
    const kernel = this.activeKernel ?? snap.sourceKernel;
    // 起一个空的新会话(新 neutralSessionId),再灌快照内容 + 惰性 seed 投影。
    await this.start(cwd, undefined, undefined, true, kernel, undefined, undefined);
    const proc = this.activeProc();
    if (!proc) throw new Error("发起收藏后未拿到会话进程");
    // 重投影:neutralEntryId 重派生到新 lineage,清 kernelEntryId/message.id(目标内核重分配)。
    // 根 lineage 必须取会话主键(proc.neutralSessionId)——根 lineageId ≡ neutralSessionId 不变量
    // (bookmark-snapshot-fork-unify §5.2/§11.2),违者内核 id 派生自随机 UUID 而非 ns,「内核会话
    // 标识反查中立 id」断链。此前另开 randomUUID() 作根 lineage,正是文档点名的偏离。
    const newLineageId = proc.neutralSessionId;
    const entries = snap.lineage.entries.map((e, i) => ({
      ...e,
      neutralEntryId: neutralEntryId(newLineageId, i),
      kernelEntryId: undefined,
      message: { ...e.message, id: undefined },
    }));
    const cur = this.readNeutral(proc) ?? emptyNeutralSession(proc.neutralSessionId, { kernel, cwd, createdAt: new Date().toISOString() });
    const next = { ...cur, lineages: [{ lineageId: newLineageId, fork: null, entries }] };
    this.putNeutral(next, { ns: proc.neutralSessionId, kind: "session", session: next });
    proc.activeLineageId = newLineageId;
    proc.materializedLineageId = ""; // 强制 seed 快照内容
    await this.materializeActiveLineage(proc);
    // 返回快照锚点在**新会话**的中立坐标(边界=前缀最后一条,seq=len-1)。渲染层 forkFromBookmark
    // 拿它 scrollTo 定位——此前返回投影路径,渲染层却拿源会话 bm.entryId 去定位,重投影后 id
    // 变了、永不命中(DRIFT-12 scrollTo 静默落空)。
    return neutralEntryId(newLineageId, entries.length - 1);
  }

  /** 取消收藏:删快照文件(元数据删除由渲染层负责)。 */
  async deleteBookmark(snapshotId: string): Promise<void> {
    const cwd = this.activeCwd;
    if (!cwd) throw new Error("无激活 cwd,无法删除收藏");
    this.bookmarkStoreFor(cwd)?.delete(snapshotId);
  }

  // ===== 中立层(kernel 版本)读写(neutral-first §6/§7)=====

  /** 中立层的读:按 neutralSessionId 读回 kernel 版本(不存在返回 null)。 */
  private readNeutral(proc: SessionProc): NeutralSession | null {
    return this.neutralStore?.get(proc.neutralSessionId) ?? null;
  }

  /** 中立层存储的只读暴露(启动迁移工具用;写仍只经本类写口)。 */
  get neutralStoreRef(): NeutralSessionStore | null {
    return this.neutralStore;
  }

  /** 订阅中立层变更通知(写穿回执;§3.2)。返回取消函数。 */
  onNeutralChange(cb: (change: NeutralChange) => void): () => void {
    this.neutralListeners.add(cb);
    return () => this.neutralListeners.delete(cb);
  }

  /** 读一个中立会话全量 + 当前活跃 lineage(渲染层镜像的基线读口;§3.2)。
   *  活跃 lineage:活进程读 proc 实况;无进程(冷开/刷新)回退根 lineage。 */
  getNeutralSession(ns: string): { session: NeutralSession | null; activeLineageId: string | null } {
    const session = this.neutralStore?.get(ns) ?? null;
    if (!session) return { session: null, activeLineageId: null };
    const proc = this.allProcs().find((p) => p.neutralSessionId === ns);
    const activeLineageId = proc?.activeLineageId ?? session.lineages.find((l) => l.fork === null)?.lineageId ?? ns;
    return { session, activeLineageId };
  }

  /** 中立层唯一写口:持久化 + 产变更通知(写与通知焊死,不落一边)。 */
  private putNeutral(session: NeutralSession, change: NeutralChange): void {
    this.neutralStore?.put(session);
    for (const cb of this.neutralListeners) {
      try { cb(change); } catch (err) { console.error("[session-store] 中立层变更监听器抛错已隔离:", err); }
    }
  }

  /** 由写后状态构造条目级变更通知:kernelEntryId 给出则按它定位(回填场景),缺省取末条(append 场景)。 */
  private entryChangeOf(proc: SessionProc, next: NeutralSession, kernelEntryId?: string): NeutralChange {
    const lineage = next.lineages.find((l) => l.lineageId === proc.activeLineageId);
    const entry = kernelEntryId
      ? lineage?.entries.find((e) => e.kernelEntryId === kernelEntryId)
      : lineage?.entries[lineage.entries.length - 1];
    return entry
      ? { ns: proc.neutralSessionId, kind: "entry", lineageId: proc.activeLineageId, entry, header: next.header }
      : { ns: proc.neutralSessionId, kind: "header", header: next.header };
  }

  /** 中立层的写:读 → 纯函数 → 写,不 mutate 持久化对象。
   *  entry 缺 neutralEntryId 时由 appendNeutralEntryWithHeader 按 seq 生成。
   *  append 即内容变更 → 列表行 header 字段(lastMessage/lastEntryId/updatedAt)随 header 一并回填。 */
  private appendNeutral(proc: SessionProc, entry: NeutralEntry): void {
    if (!this.neutralStore) return;
    const cur = this.readNeutral(proc)
      ?? emptyNeutralSession(proc.neutralSessionId, { kernel: proc.kernel, cwd: proc.cwd, createdAt: new Date().toISOString() });
    const next = appendNeutralEntryWithHeader(cur, proc.activeLineageId, entry, new Date().toISOString());
    this.putNeutral(next, this.entryChangeOf(proc, next, entry.kernelEntryId));
  }

  /** 上行同步:entryAppended → 中立层(session-single-source §4.1:降级为「回填/补漏」)。
   *  内容落盘的主触发是 messageEnd(writeThroughMessageEnd);本路径只剩三个职责:
   *  ① user 条目回填权威 id/timestamp/kernelEntryId(乐观写入的后补);
   *  ② messageEnd 已写条目的 kernelEntryId 回填(绑最近未绑的同 role 条目);
   *  ③ 不随 messageEnd 的条目(部分内核的工具结果等)兜底 append。
   *  去重:同 kernelEntryId 已在活跃 lineage → 跳过(双跑期 messageEnd 与补丁/合成
   *  entryAppended 并存,同一内容只落一条)。 */
  private syncNeutralEntry(proc: SessionProc, event: SessionEvent): void {
    if (!this.neutralStore) return;
    const raw = (event as { entry?: unknown }).entry;
    if (!raw || typeof raw !== "object") return;
    const kernelEntryId = (raw as { id?: unknown }).id;
    if (typeof kernelEntryId !== "string") return;
    // assistant 消息注入「执行时模型」:message.model 固定到发送时,中立层成为模型真相源(refresh 读得到)。
    const msg = sessionEntryToNeutral(this.withEntryModel(proc, raw));
    if (!msg) return;
    const cur = this.readNeutral(proc);
    if (!cur) return;
    if (msg.role === "user") {
      const next = backfillUserAuthority(cur, proc.activeLineageId, kernelEntryId, msg.id, msg.timestamp);
      if (next !== cur) {
        // 回填权威 id/timestamp(此前只回填 kernelEntryId,message.id/timestamp 仍缺 → refresh 无时间徽标)。
        this.putNeutral(next, this.entryChangeOf(proc, next, kernelEntryId));
        return;
      }
      // steer/总线/续跑注入的用户消息没有乐观条目可绑 → 落一条(否则中立层缺用户侧)。
      this.appendNeutral(proc, { neutralEntryId: "", kernelEntryId, message: msg });
      return;
    }
    const lineage = cur.lineages.find((l) => l.lineageId === proc.activeLineageId);
    if (lineage?.entries.some((e) => e.kernelEntryId === kernelEntryId)) return; // 幂等
    const backfilled = backfillKernelEntryId(cur, proc.activeLineageId, kernelEntryId, msg.role);
    if (backfilled !== cur) {
      this.putNeutral(backfilled, this.entryChangeOf(proc, backfilled, kernelEntryId));
      return;
    }
    this.appendNeutral(proc, { neutralEntryId: "", kernelEntryId, message: msg });
  }

  /** 写穿(session-single-source §4.1):messageEnd 是内容落盘的主触发——两个内核都产出
   *  终态 messageEnd(pi 原生;dsh 由翻译器把增量组装成完整消息)。
   *  计时归一(与渲染层 withStreamTiming 同语义):内核 message.timestamp = LLM 调用开始
   *  时间 → startedAt;条目的 timestamp = 壳写穿时刻(完成时间)。
   *  幂等:同 kernelEntryId 已落则跳过(重放/双事件防御);无 kernelEntryId(pi 补丁删后)
   *  的消息按序落,后续 entryAppended 回填补上权威 id。 */
  private writeThroughMessageEnd(proc: SessionProc, event: SessionEvent): void {
    if (!this.neutralStore) return;
    const raw = (event as { message?: NeutralMessage }).message;
    if (!raw || typeof raw !== "object") return;
    if (raw.role !== "user" && raw.role !== "assistant" && raw.role !== "toolResult") return;
    const kernelEntryId = typeof raw.id === "string" ? raw.id : undefined;
    const cur = this.readNeutral(proc);
    if (!cur) return;
    if (raw.role === "user") {
      const lineage = cur.lineages.find((l) => l.lineageId === proc.activeLineageId);
      if (kernelEntryId) {
        if (lineage?.entries.some((e) => e.kernelEntryId === kernelEntryId)) return; // 幂等
        // 优先回填 prompt() 乐观写入的条目(权威 id/timestamp 转正)
        const next = backfillUserAuthority(cur, proc.activeLineageId, kernelEntryId, kernelEntryId, raw.timestamp);
        if (next !== cur) {
          this.putNeutral(next, this.entryChangeOf(proc, next, kernelEntryId));
          return;
        }
      }
      // 内容匹配(与渲染层水合同源的双轨语义):末条未绑定 user 条目与本事件同文 →
      // 是内核回放,不重复落(权威 id 由后续 entryAppended 带回);不同文 →
      // 注入消息(steer/总线/续跑,无乐观条目)→ 落一条,否则中立层缺用户侧。
      const lastUnbound = [...(lineage?.entries ?? [])].reverse().find((e) => e.kernelEntryId === undefined && e.message.role === "user");
      if (lastUnbound && messageContentText(lastUnbound.message.content) === messageContentText(raw.content)) return;
      this.appendNeutral(proc, { neutralEntryId: "", kernelEntryId, message: { ...raw, timestamp: raw.timestamp ?? Date.now() } });
      return;
    }
    if (kernelEntryId) {
      const lineage = cur.lineages.find((l) => l.lineageId === proc.activeLineageId);
      if (lineage?.entries.some((e) => e.kernelEntryId === kernelEntryId)) return; // 幂等
    }
    this.appendNeutral(proc, {
      neutralEntryId: "",
      kernelEntryId,
      message: {
        ...raw,
        startedAt: raw.startedAt ?? (typeof raw.timestamp === "number" ? raw.timestamp : undefined),
        timestamp: Date.now(),
        // assistant 消息注入「执行时模型」(与 entryAppended 路径的 withEntryModel 同语义)
        ...(proc.effectiveModel && raw.role === "assistant" ? { model: proc.effectiveModel } : {}),
      },
    });
  }

  /** assistant 消息注入「执行时模型」:message.model 由 proc.effectiveModel 决定。
   *  其余 entry(divider/自定义)不携带模型。user/未知 role 原样返回。 */
  private withEntryModel(proc: SessionProc, raw: unknown): unknown {
    if (!proc.effectiveModel) return raw;
    const e = raw as Record<string, unknown>;
    if (e.type === "message" && e.message && typeof e.message === "object") {
      const m = e.message as Record<string, unknown>;
      if (m.role === "assistant") return { ...e, model: proc.effectiveModel };
    }
    return raw;
  }

  /** 快照激活会话的中立会话树(逐 lineage:getTree 拿树 + 逐 lineage getEntries 拿独有条目)。
   *  落 neutralStore(若有)——中立树持久化是「壳不读内核存储」的落地载体。 */
  private async snapshotNeutralSession(proc: SessionProc): Promise<NeutralSession> {
    const sessionId = proc.backend.sessionId ?? proc.boundSessionPath ?? "";
    const tree = await proc.backend.getTree(sessionId); // 记录 sessionFile(pi),返回全部 lineage
    // 第一遍:逐 lineage 读 entries,填 kernelEntryId(后端私有 entry id = getEntries 的 message.id)
    // 与 neutralEntryId;fork.boundaryEntryId 先暂存私有 boundary(第二遍归一为中立 id)。
    const lineages = await Promise.all(tree.lineages.map(async (l) => {
      const entries = await proc.backend.getEntries(l.id); // l.id = 该 lineage 第一条 entry 的锚点
      return {
        lineageId: l.id,
        fork: l.fork ? { parentLineageId: l.fork.parentLineageId, boundaryEntryId: l.fork.boundary } : null,
        entries: entries.map((msg, i) => ({
          neutralEntryId: neutralEntryId(l.id, i),
          kernelEntryId: typeof (msg as { id?: unknown }).id === "string" ? (msg as { id: string }).id : undefined,
          message: msg,
        })),
      };
    }));
    // 拓扑排序(父 lineage 先于子分支;§7.3) + 边界归一(私有 boundary → 中立 id;§7.4)
    const sorted = resolveForkBoundaries(sortLineagesTopologically(lineages));
    const session: NeutralSession = {
      neutralSessionId: proc.neutralSessionId,
      header: { kernel: proc.kernel, cwd: proc.cwd, createdAt: new Date().toISOString() },
      lineages: sorted,
    };
    // 列表行 header 字段回填(全量兜底重建):从整棵树派生 lastMessage/lastEntryId/updatedAt,
    // 历史会话(此前中立层缺这些字段)重开/快照时补齐,不再退化成 id 前 8 位 + 创建时间。
    const hydrated: NeutralSession = { ...session, header: { ...session.header, ...derivedHeaderFromSession(session) } };
    this.putNeutral(hydrated, { ns: proc.neutralSessionId, kind: "session", session: hydrated });
    return hydrated;
  }

  /** 跨内核切换(session-neutral-layer.md §19 + kernel-switch-projection.md):abort → 落定 →
   *  快照(拓扑序 + 边界归一)→ stop 旧 → 查绑定(失效回退)→ 分内核 seed/start → 重绑 → 收尾。
   *  回切经映射表找回目标内核已有私有形态,不重复 seed(pi 有效;dsh 内存态不可续,恒 seed)。 */
  async switchKernel(target: KernelId): Promise<void> {
    // 暂缓切换(§3.2):入口 gate,七步编排原样保留,未来放开时删掉这个判断。
    if (!this.switchKernelEnabled) throw new Error("跨内核切换暂未启用");
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("内核未启动");
    if (proc.kernel === target) return;
    if (this.switching) throw new Error("切换进行中"); // §15.1 互斥
    this.switching = true;
    const key = proc.key;
    try {
      // 1. abort + 落定(§6):事件驱动等在飞回合收尾,不丢半截消息
      await proc.backend.abort().catch(() => {});
      await this.waitSettled(proc, ABORT_TIMEOUT_MS);
      // 2. 读中立层(唯一真相源,§kernel-forkless §15.3/§22);中立层缺失才快照兜底重建。
      //    常规路径不读内核树——中立层随上行同步持续新鲜,快照只是损坏兜底。
      const session = this.readNeutral(proc) ?? await this.snapshotNeutralSession(proc);
      // 2b. 活跃 lineage 的 seed 投影(§4.1 契约单源:压缩截断 + role 白名单)——
      //    投的是组装后的投影,不是整棵树的原始内容
      const activeLineageId = proc.activeLineageId;
      const lineage = assembleSeedProjection(session, activeLineageId);
      // 3. stop 旧内核
      await proc.backend.stop();
      // 并发护栏(§15.3):stop 的 await 窗口内激活态被切走则中止
      if (this.activeProcKey !== key) throw new Error("切换被并发上下文切换打断");
      // 4. seed 活跃 lineage(幂等,id 派生自 lineageId §12.2;生命周期不对称 §4.5)
      //    去映射表:内核侧 id 由 lineageId 确定,回切重算同 id,不查表不存表(§12.3)。
      const seedOpts = {
        kernel: target, cwd: proc.cwd, agentDir: this.agentDir,
        neutralSessionId: proc.neutralSessionId, lineageId: activeLineageId,
        header: { ...session.header, kernel: target },
      };
      const seedFn = this.factory.seed;
      const seeded = seedFn ? await seedFn(lineage, seedOpts) : null;
      let newBackend: BaseBackend;
      let newSessionId: string;
      if (seeded != null) {
        // pi:纯文件写,先 seed 得派生路径、再以该路径 spawn
        newSessionId = seeded;
        newBackend = this.factory.create({
          cwd: proc.cwd, agentDir: this.agentDir, kernel: target,
          systemPromptPaths: this.getSystemPromptPaths(),
          systemPromptTexts: proc.role ? [roleToPrompt(proc.role)] : undefined,
          neutralSessionId: proc.neutralSessionId,
        });
        await newBackend.start();
      } else {
        // dsh:RPC 依赖进程,先 start 后 seed
        newBackend = this.factory.create({
          cwd: proc.cwd, agentDir: this.agentDir, kernel: target,
          neutralSessionId: proc.neutralSessionId,
          systemPromptPaths: this.getSystemPromptPaths(),
        });
        await newBackend.start();
        // 空 lineage 跳过 seed:没东西可灌,直接以后端构造标识起目标内核——
        // 身份不变量(§4.3):标识必须已在,不为空会话拼兜底名。
        if (lineage.length === 0) {
          const sid = newBackend.sessionId;
          if (!sid) throw new Error("目标内核未返回会话标识(身份不变量)");
          newSessionId = sid;
        } else {
          newSessionId = await newBackend.seed(lineage, seedOpts);
        }
      }
      // 5. 模型中立化(§11):读 proc.lastModelRef 跨切换载体,不读 latestSnapshot(dsh 下恒 null)
      if (proc.lastModelRef && this.modelCatalog) {
        const resolved = this.modelCatalog.resolveModel(target, proc.lastModelRef);
        if (resolved) {
          await newBackend.setModel(resolved.provider, resolved.model).catch(() => {});
        } else {
          console.warn(`[session-store] 目标内核 ${target} 无对应档位模型(${proc.lastModelRef.ref}),回落默认`);
        }
      }
      // 6. 重绑
      proc.backend = newBackend;
      proc.kernel = target;
      proc.nonce = randomUUID(); // 换绑即换出生证:旧进程的提问永不误入新进程(ask-design §4.3)
      proc.boundSessionPath = newBackend.capabilities.pi ? newSessionId : null;
      proc.configSnapshot = this.captureConfigSnapshot(proc.backend.configDepPaths ?? []);
      this.bindProcEvents(proc);
      // 7. 周边收尾(§9.2/§9.3)
      await this.writeKernelToHeader(proc).catch(() => {});
      this.latestSnapshot = newBackend.capabilities.pi ? await this.sync().catch(() => null) : null;
      this.dispatchKernel({ kind: "kernelChanged", sessionKey: proc.key, kernel: target, capabilities: this.sessionCapabilitiesOf(proc) });
    } finally {
      this.switching = false;
    }
  }

  /** 等在飞回合落定(§6):订阅 agentSettled / 带 stopped·error 的 messageEnd /
   *  compactionEnd / autoRetryEnd(success!==true),超时兜底。事件驱动,不 sleep 不轮询。 */
  private waitSettled(proc: SessionProc, timeoutMs: number): Promise<void> {
    if (!this.isBusy(proc.key)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let off: () => void = () => {};
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        off();
        resolve();
      };
      off = this.onSessionEvent(proc.key, (ev) => {
        if (ev.type === "agentSettled") finish();
        else if (ev.type === "messageEnd") {
          const stop = (ev as { message?: { stopped?: boolean; error?: boolean } }).message;
          if (stop?.stopped || stop?.error) finish();
        } else if (ev.type === "compactionEnd") finish();
        else if (ev.type === "autoRetryEnd" && (ev as { success?: boolean }).success !== true) finish();
      });
      timer = setTimeout(finish, timeoutMs);
    });
  }

  /** kernel 归属收口(§9.2):真相源 = 中立 header.kernel(switchKernel 已更新);有会话文件的内核
   *  (pi)顺手把头行 custom.kernel 写回,无文件内核(dsh)boundSessionPath 为 null 自然跳过。 */
  private async writeKernelToHeader(proc: SessionProc): Promise<void> {
    if (proc.boundSessionPath) {
      await this.catalog.updateHeader(proc.boundSessionPath, { custom: { kernel: proc.kernel } }).catch(() => {});
    }
  }

  /** 内容基线(session-single-source §2.1/§4.2):活跃 lineage 的消息序列从中立层出,
   *  两内核同一条读口,不再读内核存储(get_entries 降级为灾难恢复面,§6)。
   *  与 openSession 同一推导:完整线性内容 + 展示元数据(图)合回 + 去重。 */
  private neutralMessagesOf(proc: SessionProc): NeutralMessage[] {
    const session = this.readNeutral(proc);
    if (!session) return [];
    return neutralMessagesOfSession(session, proc.activeLineageId);
  }

  /** 逐条明细树的中立层投影(§209:get_tree → 中立层读,两内核同一数据源)。
   *  中立层缺失(迁移过渡)回落空树——树是诊断视图,空树是诚实缺面,不伪造。 */
  private neutralTreeOf(proc: SessionProc): TreeNode[] {
    const session = this.readNeutral(proc);
    if (!session) return [];
    return neutralSessionToTree(session);
  }

  /** resync 一次并广播新基线(start 后与显式刷新走这里)。作用于激活会话。
   *  内容面(messages/tree)= 中立层(两内核同源,§209);状态面(state)= pi 仍走内核实况
   *  (过渡——执行态面 §3.4 收敛后退役),dsh 由壳记账 + 中立头组装。 */
  async sync(): Promise<SyncSnapshot> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("内核未启动");
    const messages = this.neutralMessagesOf(proc);
    if (!proc.backend.capabilities.pi) {
      // dsh(无 pi 扩展面=无快照面):基线照常产出——内容来自中立层,状态由壳记账组装。
      // 此前 sync 对 dsh 降级为返回旧基线/空,渲染层无基线可用;中立层单源后两内核同等待遇。
      const base = this.latestSnapshot ?? emptySnapshot();
      const header = this.readNeutral(proc)?.header;
      const snapshot: SyncSnapshot = {
        ...base,
        state: {
          ...base.state,
          isStreaming: this.isBusy(this.activeProcKey),
          sessionId: proc.backend.sessionId ?? "",
          sessionName: header?.name ?? base.state.sessionName,
          messageCount: messages.length,
        },
        messages,
        // 逐条明细树同走中立层投影(session-single-source §209:get_tree → 中立层读)——
        // dsh 从此有真树(此前恒空),与 pi 同一数据源、同一新鲜度。
        tree: this.neutralTreeOf(proc),
      };
      this.latestSnapshot = snapshot;
      for (const cb of this.snapshotListeners) {
        try {
          cb(snapshot);
        } catch (err) {
          console.error("[session-store] 快照监听器抛错已隔离:", err);
        }
      }
      return snapshot;
    }
    const snapshot = await this.asPi(proc).resync();
    // 内容面换中立层(单源):pi 的 get_entries 读到的内核文件内容不再是渲染基线。
    snapshot.messages = messages;
    // 逐条明细树同换中立层投影(§209):pi 的 get_tree 只剩灾难恢复工具面(§6),
    // 渲染基线的树与消息同源同新鲜度——此前树停在 sync 发起时刻的内核态,回合间走旧。
    snapshot.tree = this.neutralTreeOf(proc);
    // 内核 auto-retry 退避期 get_state.isStreaming 报 false,以 busyStates 记账为准折算。
    snapshot.state.isStreaming = snapshot.state.isStreaming || this.isBusy(this.activeProcKey);
    this.latestSnapshot = snapshot;
    // sync 回写(设计 §4.4):进程≠头时以进程为真相回写头——内核 CLI /model、
    // cycle 命令、扩展自切等旁路变更,最晚在本次 sync 落盘到头。
    // 方向无条件进程→头:onSend 意图在 renderer 内存 pending,回写物理碰不到。
    if (this.activeSessionPath) {
      const fromState = this.modelPrefsFromState(snapshot.state);
      if (fromState) {
        const fromHeader = parseSessionModelPrefs((await this.catalog.readCustom(this.activeSessionPath)) ?? undefined);
        const same = fromHeader
          && fromHeader.provider === fromState.provider
          && fromHeader.modelId === fromState.modelId
          && fromHeader.thinkingLevel === fromState.thinkingLevel;
        if (!same) {
          await this.writeModelPrefsToHeader(this.activeSessionPath, fromState);
          // 中立层同步收敛(真相源);kernel 缺省时保留头内既有归属,不覆盖。
          await this.writeNeutralModelPrefs(this.activeSessionPath, { ...fromState, kernel: fromState.kernel ?? proc.kernel });
        }
      }
    }
    for (const cb of this.snapshotListeners) {
      try {
        cb(snapshot);
      } catch (err) {
        console.error("[session-store] 快照监听器抛错已隔离:", err);
      }
    }
    return snapshot;
  }

  /** 订阅新基线快照(start/sync 后每次广播一次)。 */
  onSnapshot(cb: (snapshot: SyncSnapshot) => void): () => void {
    this.snapshotListeners.add(cb);
    return () => this.snapshotListeners.delete(cb);
  }

  /** 读当前基线(无基线且 pi 活着时现拉;pi 未启动 reject,调用方走文件读)。 */
  async getSnapshot(): Promise<SyncSnapshot> {
    if (this.latestSnapshot) return this.latestSnapshot;
    return this.sync();
  }

  onEvent(cb: (event: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onKernelEvent(cb: (event: KernelEvent) => void): () => void {
    this.kernelListeners.add(cb);
    return () => this.kernelListeners.delete(cb);
  }

  // ============ ask 提问:持久请求单(ask-design §4/§5/§6) ============

  onQuestion(cb: (req: QuestionRequestEvent) => void): () => void {
    this.questionListeners.add(cb);
    return () => this.questionListeners.delete(cb);
  }

  /** 提问落账(先落账再投递,ask-design §4.3):准入 = 能对账到 ask_user_question 的
   *  toolCallStart(其他扩展的 select/input 帧只投不落,防误持久化/误铸造 toolResult)。
   *  真实 q.id 经 lastAskQuestions 按问句文本对账(pi 帧里的 id 是合成物)。 */
  private mintQuestionRecord(proc: SessionProc, req: { requestId: string; questions: Question[] }): void {
    if (!this.questionStore) return;
    if (this.questionStore.has(req.requestId)) return; // 幂等:重投/桥重扫不重复落账
    const toolCallId = proc.lastAskToolCallId ?? null;
    if (!toolCallId) return; // 准入:对不上 ask toolCallStart 的帧不落账(维持瞬态)
    const argsQuestions = proc.lastAskQuestions;
    const questions = req.questions.map((q) => {
      const hit = argsQuestions?.find((aq) => aq.question === q.question);
      return hit ? { ...q, id: hit.id } : q;
    });
    this.questionStore.put({
      requestId: req.requestId, kernel: proc.kernel, neutralSessionId: proc.neutralSessionId,
      cwd: proc.cwd, sessionKey: proc.key, procNonce: proc.nonce, toolCallId,
      model: proc.effectiveModel ? { provider: proc.effectiveModel.provider, modelId: proc.effectiveModel.modelId } : undefined,
      questions, status: "pending", createdAt: new Date().toISOString(),
    });
  }

  /** toolCallEnd 对账(§5.3):命中 pending 记录 → 结算。覆盖 abort 等不经卡片的收尾。 */
  private settleQuestionByToolCallEnd(toolCallId: string, event: SessionEvent): void {
    const rec = this.questionStore?.findPendingByToolCallId(toolCallId);
    if (!rec) return;
    const result = (event as { result?: unknown }).result;
    const answers = (result as { answers?: QuestionAnswer[] } | undefined)?.answers;
    const cancelled = JSON.stringify(result ?? "").includes("User cancelled");
    this.questionStore!.settle(rec.requestId, cancelled ? "cancelled" : "answered", answers);
  }

  /** 按记录找进程:先按 sessionKey 直查(rekey 后兜底全扫 neutralSessionId+kernel)。 */
  private procForRecord(record: PendingQuestionRecord): SessionProc | null {
    const byKey = this.procs.get(record.sessionKey)?.get(record.kernel);
    if (byKey) return byKey;
    return this.allProcs().find((p) => p.kernel === record.kernel && p.neutralSessionId === record.neutralSessionId) ?? null;
  }

  async answerQuestion(requestId: string, answers: QuestionAnswer[]): Promise<void> {
    const record = this.questionStore?.get(requestId) ?? null;
    if (!record) {
      // 未落账的提问(非 ask 工具的瞬态帧 / store 未装配):旧活路路由,不读全局
      // activeKernel 偶然态(dsh 问句撞 pi 内核误报「内核未启动」的根因)。
      const kernels = this.procs.get(this.activeProcKey);
      const candidates = kernels ? [...kernels.values()] : [];
      const proc = candidates.find((p) => p.backend.answerQuestion && p.backend.alive)
        ?? candidates.find((p) => p.backend.answerQuestion)
        ?? null;
      if (!proc) throw new Error("提问已失效：会话进程已不在（应用可能重启过），请让模型重新发起提问");
      await proc.backend.answerQuestion!(requestId, answers);
      return;
    }
    // 防重(幂等防线:多窗口/重投竞态)
    if (record.status !== "pending") throw new Error("该提问已作答，请勿重复提交");
    // 落账先于分发——答案接收与内核死活无关(答案永不丢)
    const cancelled = answers.every((a) => a.selected.length === 0 && !(a.custom ?? "").trim());
    this.questionStore!.settle(requestId, cancelled ? "cancelled" : "answered", answers);
    // 分发:按 record.kernel 找槽位,nonce 匹配 + alive → 活路;否则续路(迟到 toolResult 补写)
    const proc = this.procForRecord(record);
    if (proc && proc.nonce === record.procNonce && proc.backend.alive && proc.backend.answerQuestion) {
      await proc.backend.answerQuestion(requestId, answers);
      this.questionStore!.markDelivered(requestId);
      return;
    }
    await this.resumeAnswer({ ...record, answers }, cancelled); // 续路读落账后的新鲜答案(record 是 settle 前的旧引用)
  }

  /** 续路(ask-design §5/§6):内核无法再铸造时,壳把迟到的 tool_result 按同构形状补上。
   *  步骤:停同槽位活进程(运行中的内核不重读存储)→ catalog.appendToolResult 落盘 →
   *  中立层双写 → 合成 toolCallEnd(卡片免刷新结算)→ 回填消息触发新回合(cancelled 不发)。 */
  private async resumeAnswer(record: PendingQuestionRecord, cancelled: boolean): Promise<void> {
    if (this.resumingQuestions.has(record.requestId)) return; // 在飞去重(水合补投竞态)
    this.resumingQuestions.add(record.requestId);
    try {
      // 重读最新记录(根因:answerQuestion 先落账再调这里,入参是落账前的旧快照,
      // 不带 answers——旧快照直接落盘会把 {"answers":[]} 写进会话文件,真答案丢失)。
      const rec = this.questionStore!.get(record.requestId) ?? record;
      const catalog = this.catalogFor(rec.kernel);
      const outcome: ToolResultWriteback = cancelled ? { cancelled: true } : { answers: rec.answers ?? [] };
      let wrote = false;
      if (rec.toolCallId && catalog.appendToolResult) {
        const proc = this.procForRecord(rec);
        if (proc?.backend.alive) await proc.backend.stop().catch(() => {}); // H5:活进程不重读存储,先停
        try {
          await catalog.appendToolResult(rec.sessionKey, rec.toolCallId, outcome, rec.cwd);
          wrote = true;
        } catch (err) {
          // 锚点校验失败(fork 走远)/格式不识(dsh 压缩存量)→ 降级为用户消息通道,不伪造落盘
          console.warn("[session-store] 续路落盘失败,降级为回填消息:", err instanceof Error ? err.message : String(err));
        }
      }
      if (wrote && rec.toolCallId) {
        this.appendToolResultNeutral(rec, outcome);
        // 视图流即时结算(renderer applyEvent 按 toolCallId 回填 result 进内容块)
        this.dispatch(rec.sessionKey, {
          type: "toolCallEnd", toolCallId: rec.toolCallId,
          result: { answers: rec.answers ?? [] }, isError: cancelled,
        });
      }
      if (!cancelled) {
        // 回填消息触发新回合(中立标记 + 答案 JSON;toolResult 不自己触发回合,消息是触发器)。
        // prefs 带记录时的模型归属,路由到提问的归宿内核,不读全局偶然态;
        // thinkingLevel 空串 = 未知,prompt 的强度对齐对 falsy 跳过(不伪造档位)。
        const payload = `[ask-answer] ${JSON.stringify({ answers: rec.answers ?? [] })}`;
        const prefs: SessionModelPrefs | undefined = rec.model
          ? { provider: rec.model.provider, modelId: rec.model.modelId, kernel: rec.kernel, thinkingLevel: "" }
          : undefined;
        await this.prompt(payload, undefined, undefined, prefs).catch((e) => {
          console.error("[session-store] 续路回填消息发送失败:", e);
          throw e; // 交付失败 → delivered 不置位,水合补投兜底
        });
      }
      this.questionStore!.markDelivered(rec.requestId);
    } finally {
      this.resumingQuestions.delete(record.requestId);
    }
  }

  /** 中立层双写 toolResult(壳的读真相源;与内核存储同一条目,refresh/冷开一致)。 */
  private appendToolResultNeutral(record: PendingQuestionRecord, outcome: ToolResultWriteback): void {
    if (!this.neutralStore) return;
    const cancelled = "cancelled" in outcome && outcome.cancelled;
    const answers = cancelled ? [] : outcome.answers;
    // NeutralMessage 是开放形状([key: string]: unknown),toolCallId/toolName/details 透传。
    const msg = {
      role: "toolResult",
      content: [{ type: "text", text: cancelled ? "User cancelled the question" : JSON.stringify({ answers }) }],
      toolCallId: record.toolCallId ?? undefined,
      toolName: "ask_user_question",
      details: { answers },
      isError: cancelled,
    } as NeutralMessage;
    const cur = this.neutralStore.get(record.neutralSessionId);
    if (!cur) return;
    // 追加到提问所在 lineage:dsh 的 sessionKey 是裸 lineageId 直接命中;pi 的 sessionKey
    // 是文件路径,派生文件名 = lineageId,经 neutralSessionIdFromPath 反查命中分支;
    // 都不中回落根 lineage。
    const sessionLineageId = this.neutralSessionIdFromPath(record.sessionKey);
    const lineageId = cur.lineages.find((l) => l.lineageId === record.sessionKey)?.lineageId
      ?? (sessionLineageId ? cur.lineages.find((l) => l.lineageId === sessionLineageId)?.lineageId : undefined)
      ?? cur.lineages.find((l) => l.fork === null)?.lineageId ?? record.neutralSessionId;
    this.neutralStore.put(appendNeutralEntryWithHeader(cur, lineageId, { neutralEntryId: "", message: msg }, new Date().toISOString()));
  }

  async getPendingQuestions(): Promise<PendingQuestionRecord[]> {
    if (!this.questionStore || !this.activeSessionPath) return [];
    const ns = this.neutralSessionIdFromPath(this.activeSessionPath);
    if (!ns) return [];
    return this.questionStore.listBySession(ns).filter((r) => r.status === "pending");
  }

  /** 会话激活时的提问水合(ask-design §8.1):重投 pending(卡片复活)+
   *  补投 answered 而未 delivered(落账成功但分发中断——答案永不丢是闭环)。 */
  private rehydrateQuestions(): void {
    if (!this.questionStore || !this.activeSessionPath) return;
    const ns = this.neutralSessionIdFromPath(this.activeSessionPath);
    if (!ns) return;
    for (const rec of this.questionStore.listBySession(ns)) {
      if (rec.status === "pending") {
        const evt: QuestionRequestEvent = { kind: "question", requestId: rec.requestId, sessionKey: rec.sessionKey, questions: rec.questions };
        for (const cb of this.questionListeners) {
          try { cb(evt); } catch (err) { console.error("[session-store] 提问监听器抛错已隔离:", err); }
        }
      } else if (rec.status === "answered" && !rec.delivered) {
        void this.resumeAnswer(rec, false).catch((e) => console.warn("[session-store] 提问补投失败:", e));
      }
    }
  }

  /** prompt 发送前对账(ask-design §6.6):任何新请求发出前配对必须闭合——
   *  悬着 nonce 不匹配的 ask 记录直接发,pi 会被 provider 400。先补 cancelled toolResult。
   *  纯文件/catalog 操作,不依赖进程(prompt 顶部调用,先于一切 spawn)——
   *  pi 在 spawn 时把会话文件读进内存且不重读,闭合必须赶在进程读到旧文件之前。
   *  同槽位有 nonce 不匹配的旧活进程 → 先停(它内存里还是悬空态,留着必读不出闭合)。 */
  private async reconcilePendingQuestionsBeforeSend(): Promise<void> {
    if (!this.questionStore || !this.activeSessionPath) return;
    const ns = this.neutralSessionIdFromPath(this.activeSessionPath);
    if (!ns) return;
    const liveProc = this.activeProc();
    const pendings = this.questionStore.listBySession(ns)
      .filter((r) => r.status === "pending" && r.procNonce !== liveProc?.nonce && r.toolCallId);
    for (const rec of pendings) {
      const catalog = this.catalogFor(rec.kernel);
      if (!catalog.appendToolResult) {
        throw new Error("存在未作答的提问，请先在会话流中回答或放弃后再发送");
      }
      if (liveProc?.backend.alive) {
        await liveProc.backend.stop().catch(() => {});
        this.procs.get(this.activeProcKey)?.delete(rec.kernel);
      }
      try {
        await catalog.appendToolResult(rec.sessionKey, rec.toolCallId!, { cancelled: true }, rec.cwd);
      } catch (e) {
        console.warn("[session-store] 发送前对账落盘失败(降级仅标记):", e);
      }
      this.questionStore.settle(rec.requestId, "cancelled");
      this.dispatch(rec.sessionKey, { type: "toolCallEnd", toolCallId: rec.toolCallId!, result: { answers: [] }, isError: true });
    }
  }

  /** 工具清单(可缺面):读当前内核可用工具;无活跃进程或不支持工具发现 → null(壳走降级)。 */
  async listTools(): Promise<KnownToolInfo[] | null> {
    const proc = this.activeProc();
    if (!proc?.backend.listTools) return null;
    return proc.backend.listTools();
  }


  /** 注入外部(非 backend)来源的提问请求(dsh 文件侧车桥由 bootstrap 装配后经此投递,汇入统一中性通道)。
   *  视图流仅激活会话;归属判定按 sessionKey 匹配**激活会话任一内核槽位**的后端 sessionId——
   *  不读全局 activeKernel(它是「最后用过的内核」的偶然态:先开过 pi 会话再开 dsh 会话时
   *  activeKernel 仍停在 pi,dsh 问句按 activeProc(activeKernel) 查找会落空误丢——
   *  「问问题不展示」的根因之一)。空串(旧桥/归属未知)不拦,保持向后兼容。
   *  照存不投(ask-design §4.2):无可答进程不再丢单——先落账(待水合重投),只是不投当前视图。 */
  injectQuestion(req: QuestionRequestEvent): void {
    // 查重:已结算的重复投递直接跳过(dsh 桥重启全量重扫会重投旧问句文件,含 abort 孤儿)
    const existing = this.questionStore?.get(req.requestId);
    if (existing && existing.status !== "pending") return;
    // 归属 proc 全扫(不只激活会话):拿 nonce/toolCallId 落账;dsh 问句可能来自非激活会话
    const ownerProc = req.sessionKey !== ""
      ? this.allProcs().find((p) => p.backend.sessionId && p.backend.sessionId === req.sessionKey) ?? null
      : null;
    if (!existing && ownerProc) this.mintQuestionRecord(ownerProc, req);
    const kernels = this.procs.get(this.activeProcKey);
    const candidates = kernels ? [...kernels.values()].filter((p) => p.backend.alive) : [];
    if (candidates.length === 0) {
      console.warn(`[session-store] 提问到达时无可答会话进程,照存不投(待水合): ${req.requestId}`);
      return;
    }
    if (req.sessionKey !== "") {
      const hit = candidates.some((p) => p.backend.sessionId && p.backend.sessionId === req.sessionKey);
      if (!hit) return; // 别的会话的提问,不投给当前视图(已落账,不丢)
    }
    for (const cb of this.questionListeners) {
      try { cb(req); } catch (err) { console.error("[session-store] 提问监听器抛错已隔离:", err); }
    }
  }

  /** 发消息(唯一会起进程的入口:ensureForSend 后才发)。作用于激活会话。
   *  display:展示元数据(图)——先写进中立层(kernel 版本),后端只收纯 AI 内容(过滤 display)。
   *  prefs:会话级模型/思考强度偏好(可选)。§atomic-send:回灌编排收进用例层——
   *  renderer 拼一个 SessionModelPrefs 传下来,这里一次编排「模型对齐→强度对齐→发消息」,
   *  不再由 renderer 逐条 setModel/setThinkingLevel/sync。 */
  async prompt(text: string, images?: ImageInput[], display?: DisplayMeta, prefs?: SessionModelPrefs): Promise<void> {
    // 发送前对账(ask-design §6.6)必须先于一切 spawn:setModel→ensureForSend 会起进程,
    // pi 在 spawn 时把会话文件读进内存且不重读——对账若排在其后,闭合的 cancelled
    // toolResult 落盘了但进程内存里仍是悬空 tool_use,下一请求照样被 provider 400。
    // 所以这里先闭合悬空记录(纯文件/catalog 操作,不依赖进程),再走模型对齐与发送。
    await this.reconcilePendingQuestionsBeforeSend();
    // 无显式偏好时的服务端兜底:读中立层会话头已持久化的模型域(setModel 落)。
    // 覆盖「重开历史 dsh 会话再发」——renderer 对已开会话不传偏好,此前这种发送
    // 拿不到模型/内核归属,要么落空要么撞全局 activeKernel 的偶然态;现在按头读回,
    // 会话是谁的由会话自己说了算(§2.4/§3.3)。查无实据(全新会话且未选模型)保持
    // prefs 为空 → 下方「会话未启动,请先选择模型」显式报错,不静默回落任何内核。
    if (!prefs && this.activeSessionPath) {
      const ns = this.neutralSessionIdFromPath(this.activeSessionPath);
      const headerPrefs = ns ? parseSessionModelPrefs(this.neutralStore?.get(ns)?.header.custom ?? undefined) : null;
      if (headerPrefs?.provider && headerPrefs?.modelId && headerPrefs.kernel) prefs = headerPrefs;
    }
    // §atomic-send:回灌编排先于「拿 proc」——setModel 内部 ensureForSend 起进程。
    // 顺序固定:模型对齐 → 强度对齐 → 发消息(分隔线永远落在正文之前)。
    if (prefs?.provider && prefs?.modelId) {
      if (!prefs.kernel) throw new Error("无法确定会话内核：模型未携带内核归属，请先选择模型");
      await this.setModel(prefs.provider, prefs.modelId, prefs.kernel);
    }
    // §atomic-send 修订:强度对齐只对「支持运行时切档」的内核生效(能力探测,非内核身份硬分支)。
    // 根因:composer 的 pickModel 无条件把默认档位盖进 pending,而 setThinkingLevel 已从
    // PiBackendExtensions 提升进契约、dsh 继承缺面默认抛错——dsh 每次带 pending 发送都被它打断成
    // 「当前内核不支持思考强度切换」。dsh 的 reasoningEffort 在 initialize/settings.yaml 定、
    // 无运行时 RPC,发送路径上该意图无意义 → 跳过而非抛错;显式切档(setThinkingLevel IPC /
    // cycleThinkingLevel / immediate 模式)仍走契约抛错显形(§7.6 显式降级)。
    if (prefs?.thinkingLevel && this.activeProc()?.backend.capabilities.pi) {
      await this.setThinkingLevel(prefs.thinkingLevel);
    }
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("会话未启动，请先选择模型");
    // 惰性物化(§kernel-forkless §15.1 + session-single-source §4.4):活跃 lineage 未物化
    // (fork 后 / dsh 重开历史会话的新进程)则先把中立层 seed 投影进内核再发。
    // dsh 侧这条替代旧的 session/continue 重放补面——中立层内容灌给内核,比内核
    // 演自己的日志更全(含分隔线),也消掉「重放期间发送撞 id collision」的时序窗口。
    await this.materializeActiveLineage(proc);
    // 中立层先写 user entry(message + display):展示元数据归中立层,不进后端投影(neutral-first §10)。
    this.appendNeutral(proc, { neutralEntryId: "", message: { role: "user", content: text }, display });
    await proc.backend.sendMessage(text, images);
    proc.touched = true; // 已落会话内容:多会话并存保护,不再被 setContext 回收
    // 发送确立"当前会话流":推给 renderer 水合 useUiStore.currentSessionPath
    // (根因修复,勿回退):内核 session_start 是纯扩展事件,永远不会出现在 RPC
    // stdout 流里,renderer 永远等不到内核推出→useUiStore.currentSessionPath
    // 恒 null→renderer sendText 每次发送都走 startNewChat 分支→ensureForSend
    // 每次生成全新 sessionPath→笔记/常用语连点两次=两个新会话。修复:发送
    // 成功后 main 主动推 synthetic sessionStart,renderer 现有 onEvent 分支
    // 直接水合;已发出的发送目标就是当前会话流,再发一条基于当前会话续发。
    if (this.activeSessionPath) {
      this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: this.activeSessionPath });
    }
    // 自动命名条件是"活跃会话还没有名字"而非"新会话":真实使用多为 CLI 建会话、
    // desktop 打开续聊,wasNewSession(activeSessionPath===null) 恒 false,autoName 永不触发。
    // 「有没有名字」的真相源(根因修复,勿回退):latestSnapshot 是 pi 专属面,dsh 恒 null——
    // 旧判据 !latestSnapshot?.state.sessionName 对 dsh 恒真,每条消息都重命名一遍(改名
    // 分隔线刷屏、「每次输入都更新会话名」的根因)。改读中立层 header.name(两内核共享;
    // 手动 rename 经 writeNeutralHeader 同步进来,不会被自动命名覆盖;清空后重发消息会
    // 重新自动命名——已知取舍,见 docs/design/session-name-tracks.md §4.4),pi 侧保留
    // 快照优先(进程内实时真相)。
    const neutralName = (() => {
      if (!this.activeSessionPath) return undefined;
      const ns = this.neutralSessionIdFromPath(this.activeSessionPath);
      return ns ? this.neutralStore?.get(ns)?.header.name : undefined;
    })();
    const currentName = this.latestSnapshot?.state.sessionName ?? neutralName;
    if (this.activeSessionPath && !currentName) {
      const autoName = truncateSessionName(text);
      if (autoName) {
        try {
          // 中立命名意图(§BaseBackend.setSessionName),不再经 asPi/piSend 直连 pi 扩展面。
          // dsh 的 session/rename 会落 session/meta 事件,而 dsh 源码 known-event-types 漏收该
          // 类型——resume 重放曾因此拒绝。此缺口已由 my-harness-fit-dsh-extension 在运行时把
          // session/meta 补进 KNOWN_SESSION_EVENT_TYPES(桌面适配插件补面,不改 dsh 源码),
          // 故这里恢复正常命名路径,无需再按内核身份跳过(§1.4)。
          await proc.backend.setSessionName(autoName);
          if (this.latestSnapshot) this.latestSnapshot.state.sessionName = autoName;
          await this.writeNeutralHeader(this.activeSessionPath, { name: autoName });
          this.dispatchRenameDivider(autoName);
        } catch (e) {
          console.error("[session-store] 自动命名失败:", { path: this.activeSessionPath, name: autoName, error: e });
        }
      }
    }
  }

  async abort(): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) return;
    // 内核无关:中断顺序(pi 的 abortBash 先行 / dsh 的单次 sessionAbort)各自归适配器
    // (§6.4),壳只调 backend.abort()。此前壳在这里手写 pi 专属 abortBash 顺序,把
    // 内核身份漏进了中立方法(§1.5 判别气味)。
    try {
      await proc.backend.abort();
    } catch {
      // abort 超时(工具未响应 agent signal 中断,如 Windows taskkill 偶发失败)
      // → 杀进程强制停止:进程死了工具必停;会话是文件,重启即恢复,不丢数据。
      proc.backend.stop().catch(() => {});
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.piSend((pi) => pi.getModels());
  }

  /** 双写第二半(设计 §4.1):RPC 成功后把全量三字段写进头行 model 域。
   *  patch 失败不阻塞(锁超时/磁盘错误/文件未落盘)——头短暂落后是投影合法态,
   *  文件未落盘时记 proc.pendingModelPrefs 待 messageStart 补写,其余交 sync 回写收敛。 */
  private async writeModelPrefsToHeader(sessionPath: string, prefs: SessionModelPrefs): Promise<void> {
    // 文件未落盘是 pi 懒建会话的设计内瞬态(pi 进程首发才创建文件):记 pending 待
    // messageStart 补写,安静返回——不为合法瞬态打错误堆栈(此前每次启动都误报"会话文件不存在")。
    if (!existsSync(sessionPath)) {
      const proc = this.allProcs().find((p) => p.boundSessionPath === sessionPath);
      if (proc) proc.pendingModelPrefs = prefs;
      return;
    }
    try {
      // 写三字段 + kernel(kernel 是模型的派生量,与模型同域原子落盘——重开据此无歧义读回内核)。
      await this.catalog.updateHeader(sessionPath, {
        custom: { [SESSION_MODEL_PREFS_KEY]: { provider: prefs.provider, modelId: prefs.modelId, thinkingLevel: prefs.thinkingLevel, ...(prefs.kernel ? { kernel: prefs.kernel } : {}) } },
      });
    } catch (e) {
      const proc = this.allProcs().find((p) => p.boundSessionPath === sessionPath);
      if (proc) proc.pendingModelPrefs = prefs;
      console.warn("[session-store] 模型偏好写头降级(待补写或 sync 收敛):", e);
    }
  }

  /** 中立层落模型域 + 内核归属(真相源,全内核;设计 §4.1 的中立半)。
   *  header.kernel 与 custom.model 原子落盘——重开/重启据此无歧义读回「这个会话是谁的」,
   *  不再依赖全局 activeKernel 的偶然状态;也不再把「首个起进程的内核」误当会话归属
   *  (此前归属由抢跑进程决定,选 dsh 却记成 pi 的根因)。custom 合并写,不覆盖其他键
   *  (如插件的 custom.goal)。读不到中立会话(异常态)安静跳过。 */
  private async writeNeutralModelPrefs(sessionPath: string, prefs: SessionModelPrefs): Promise<void> {
    const ns = this.neutralSessionIdFromPath(sessionPath);
    if (!ns || !this.neutralStore) return;
    const cur = this.neutralStore.get(ns);
    if (!cur) return;
    const modelDomain = { provider: prefs.provider, modelId: prefs.modelId, thinkingLevel: prefs.thinkingLevel, ...(prefs.kernel ? { kernel: prefs.kernel } : {}) };
    const custom = { ...(cur.header.custom ?? {}), [SESSION_MODEL_PREFS_KEY]: modelDomain };
    const header = { ...cur.header, ...(prefs.kernel ? { kernel: prefs.kernel } : {}), custom };
    this.putNeutral({ ...cur, header }, { ns, kind: "header", header });
  }

  /** 旁路改模型的头域回写(§4.5):只更新 provider/modelId/kernel,thinkingLevel 读现存域保留——
   *  旁路事件不带档位,不能清掉已存值。fire-and-forget(事件流里不阻塞)。 */
  private async writeBackModelRef(sessionPath: string, provider: string, modelId: string, kernel: KernelId): Promise<void> {
    const ns = this.neutralSessionIdFromPath(sessionPath);
    if (!ns || !this.neutralStore) return;
    const cur = this.neutralStore.get(ns);
    const existing = parseSessionModelPrefs(cur?.header.custom ?? undefined);
    await this.writeNeutralModelPrefs(sessionPath, {
      provider, modelId, kernel,
      thinkingLevel: existing?.thinkingLevel ?? "",
    }).catch(() => {});
  }

  /** 从快照拼全量三字段 + kernel;凑不齐(进程未就绪边界)返回 null——交给下一次 sync 回写。 */
  private modelPrefsFromState(state: SyncSnapshot["state"]): SessionModelPrefs | null {
    const model = state.model;
    const level = state.thinkingLevel;
    if (!model || !level) return null;
    return { provider: model.provider, modelId: model.id, thinkingLevel: level, kernel: model.kernel };
  }

  async setModel(provider: string, modelId: string, kernel: KernelId): Promise<void> {
    // 内核必传(内核 = 模型的派生量,唯一权威来源)——不做 provider+modelId 反查内核,
    // 否则 pi/dsh 同名模型(同 provider+id)产生歧义(§kernel-follows-model)。
    const models = this.modelCatalog?.listModels() ?? [];
    // 只在「给定内核」下反查模型元数据(reasoning 档位),查不到即报错——不跨内核猜。
    const target = models.find((m) => m.kernel === kernel && m.provider === provider && m.id === modelId);
    if (!target) throw new Error(`模型不在清单: ${kernel}/${provider}/${modelId}`);
    const targetKernel = kernel;
    // 有历史(任意内核槽位发过消息,或中立层已有持久历史)且要换内核 → 锁死(pi 历史不让切 dsh,反之亦然)。
    // 空会话/预热(未发过消息且中立层无 entry)则自由切 activeKernel——这是「选择」不是「切换」。
    // 刷新后进程未起、touched 恒 false,但中立层 entry 仍在——补持久历史判据堵「刷新后换内核」的口。
    const hasHistory = this.allProcs().some((p) => p.key === this.activeProcKey && p.touched)
      || this.activeSessionHasHistory();
    // 会话的「固定内核」真相源是会话自身上下文(header.kernel = 会话内容属于哪个内核),
    // 不是全局 activeKernel(它跨会话残留、只记「最后一次选的内核」)。此前用 activeKernel 优先,
    // 从 dsh 会话切回有历史的 pi 会话时 fixedKernel 取到残留的 dsh,误判「跨内核切换」挡发。
    const fixedKernel = this.activeSessionKernel() ?? this.activeKernel;
    if (hasHistory && fixedKernel && targetKernel !== fixedKernel) {
      throw new Error("当前会话已固定内核，跨内核切换后续支持");
    }
    // 选模型 = 激活对应内核的槽位(并存,不替换其他内核)
    const currentKernel = this.activeKernel;
    this.activeKernel = targetKernel;
    await this.ensureForSend(targetKernel, provider, modelId);
    let proc = this.activeProc();
    if (!proc) throw new Error("内核未启动");
    // 新会话壳:spawn 时内核已在会话文件落 model_change 条目,但基线 sync 的「全元数据不冲掉
    // 乐观消息」守卫让它永不进 live 视图流(只在刷新后补现)——补一条合成分隔线直投视图流。
    const freshSpawn = !proc.touched;
    // 先留旧账本再等差量判读:effectiveModel 在下方即被写成目标值,判「已生效」要用旧值。
    const prevEffectiveModel = proc.effectiveModel ?? proc.model;
    // 记中立模型引用(§9.3/§11):跨切换模型中立化的持久载体,setModel 成功即更新。
    // 不依赖 latestSnapshot(dsh 无快照面恒 null),经受得住完整 pi→dsh→pi 往返。
    proc.lastModelRef = { ref: classifyModel({ id: modelId, reasoning: target.reasoning }) };
    // 生效模型随 setModel 更新(pi 运行时切模不重启,model 仍 spawn 定死值)——本条起 assistant
    // 消息落盘/广播都带这个模型,message.model 固定到「执行时」,不随后续切换漂移。
    proc.effectiveModel = { provider, modelId, kernel: targetKernel };
    // 差量执行(勿回退):ensureForSend 后快照是进程实况的实证探测(起进程即 sync,
    // §3.6)——进程已持目标值时同值 set_model 是纯噪声(内核会在时间线落 model_change
    // 分隔线,"只改了思考强度却冒出模型切换"即此)。跳过头收敛照旧:值已在进程生效,
    // 写头不违反 §4.1"头不记未生效值";快照缺失(实况未知)则回落为必发。
    const cur = this.latestSnapshot?.state.model;
    // 跨内核切换后 latestSnapshot 仍是旧内核基线(sync 对 dsh 降级为返回现有基线,见 sync):
    // 若 pi/dsh 有同名模型(同 provider+id),「已生效」判据会误命中旧内核快照、跳过 set_model,
    // 新内核后端停在握手默认值——内核切换必须强制重发,不参与差量跳过。
    let alreadyEffective = targetKernel === currentKernel && !!cur && cur.provider === provider && cur.id === modelId;
    // 无快照面内核(dsh)的「已生效」真相源是壳侧账本 effectiveModel 的旧值
    // (prevEffectiveModel,setModel 成功才更新;spawn 时 createProc 已按握手值初始化),
    // 不是快照(dsh 恒 null)。热切落地后 proc.model 是 spawn 定死值、不再代表生效值——
    // 勿回退读它(旧判据恒「未生效」→ 每次发送都重发 session/setModel,该方法在旧运行时
    // 是坏面,第二发起每次发送都被打断,即「dsh 不能发送第二条语句」的根因;
    // docs/model-switching.md §11.3)。
    if (!alreadyEffective && !proc.backend.capabilities.pi) {
      if (prevEffectiveModel && prevEffectiveModel.provider === provider && prevEffectiveModel.modelId === modelId) alreadyEffective = true;
    }
    if (!alreadyEffective) {
      await proc.backend.setModel(provider, modelId);
      if (!proc.backend.supportsRuntimeSetModel) {
        // 本次调用刚发现缺面(懒探测同步记进 missing):热切无路,现场回落停旧起新——
        // ensureForSend 的 needsRestart 此刻按能力位判 true,带目标模型重建;新 proc 的
        // model/effectiveModel 由 createProc 按握手参数初始化,补记中立引用与生效值即可。
        await this.ensureForSend(targetKernel, provider, modelId);
        proc = this.activeProc() ?? proc;
        proc.lastModelRef = { ref: classifyModel({ id: modelId, reasoning: target.reasoning }) };
        proc.effectiveModel = { provider, modelId, kernel: targetKernel };
      }
    }
    // 模型分隔线直投视图流:值变化(!alreadyEffective)或新会话壳(spawn 已落但基线守卫挡住 live)。
    if (!alreadyEffective || freshSpawn) {
      this.dispatchViewDivider({ type: "model_change", provider, modelId });
    }
    // 模型域落会话头(设计 §4.1)。RPC 拒绝抛错则 patch 不发生——头不会记下从未生效的值。
    // thinkingLevel 用快照现值补齐,守 model 域三字段原子替换(§3.2)。两层落点:
    //  ① 中立层(全内核,真相源):header.kernel + custom.model——内核归属随模型域持久,
    //    重开/重启后按头读回(§2.4/§3.3),不再依赖全局 activeKernel 的偶然状态;
    //    此前 dsh 缺这一域 → 重开会话丢模型/内核归属,第二发无 prefs 回灌 → 内核路由漂移
    //    (选 dsh 却调度到 pi 的根因之一)。
    //  ② pi 文件头行(仅 pi 的投影面):dsh 无文件,跳过。
    const level = this.latestSnapshot?.state.thinkingLevel ?? "";
    if (this.activeSessionPath) {
      await this.writeNeutralModelPrefs(this.activeSessionPath, { provider, modelId, thinkingLevel: level, kernel: targetKernel });
      if (level && proc.backend.capabilities.pi) {
        await this.writeModelPrefsToHeader(this.activeSessionPath, { provider, modelId, thinkingLevel: level, kernel: targetKernel });
      }
    }
    // model_select 同 sessionStart 一类(纯扩展事件,RPC stdout 收不到,见 prompt 处
    // 根因注释):不等内核事件,发完 set_model 立即 sync 一次取真实 state.model
    // (事件驱动于 RPC 完成,非 sleep/轮询;fire-and-forget 不阻塞调用方)。
    // 新会话壳进程刚起(模型在 spawn 参数里定死,alreadyEffective 恒真不走 set_model RPC,
    // 内核仍会在 spawn 时落 model_change/thinking_level_change 条目)——基线 sync 把它们
    // 带进视图流,否则这两条分隔线只在刷新后补现(违反「刷新前后一致」实测)。
    if (!alreadyEffective || !proc.touched) void this.sync().catch(() => {});
  }

  /** 模型连通性测试(ModelApi.test):起独立临时进程发一条 ping。
   *  与激活会话完全隔离——不设 activeProcKey、不走 sync/基线、事件只进运维流,时间线无感。
   *  判定:assistant messageEnd 无 error=通;set_model 响应失败 / 消息带 error /
   *  进程退出 / RPC 错 / 超时 = 不通,原文带回。
   *  零残留靠不落盘(--no-session → 内核 SessionManager.inMemory 内存会话),
   *  而非"测完删文件":删除依赖 boundSessionPath,它只能由 sessionStart 事件写入,
   *  而内核 session_start 是纯扩展事件 RPC stdout 永不见(见 waitReady 注释)、
   *  测试路径又无 synthetic dispatch——旧实现的清理从未执行,每次测试都在
   *  sessions/ 留一个 ping 文件并被 session-scanner 扫进会话列表(实证)。 */
  async test(cwd: string, provider: string, modelId: string, kernel: KernelId, timeoutMs = 60000): Promise<ModelTestResult> {
    if (!cwd) return { ok: false, error: "no working directory" };
    // 独立 proc key(`test:` 前缀永不与会话路径冲突);事件经 dispatch 走 keyed/运维流。
    const key = `test:${randomUUID()}`;
    const { proc } = this.createTestProc(key, cwd, provider, modelId, kernel);
    let kernels = this.procs.get(key);
    if (!kernels) { kernels = new Map(); this.procs.set(key, kernels); }
    kernels.set(proc.kernel, proc);
    try {
      await proc.backend.start();
      // set_model 是同步 RPC:provider/模型 id 不存在时内核回 success:false,
      // backend  reject(RpcCommandError)——转成 ModelTestResult 契约,不外抛。
      // pi 的 start 已含就绪探测；dsh 的 initialize 已设 provider/model（再 set 一次幂等）。
      try {
        await proc.backend.setModel(provider, modelId);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      // 先订阅再发 ping,不竞态(事件在先,请求在后)。
      const reply = this.awaitTestReply(key, timeoutMs);
      await proc.backend.sendMessage("ping");
      return await reply;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      try { await proc.backend.stop(); } catch (e) { console.warn(`[session-store] test proc stop failed:`, e); }
      this.procs.delete(key);
    }
  }

  /** 造一个「临时会话」测试后端(内核各自实现临时性,经中性 ephemeral 字段):
   *  pi=--no-session(内核内存会话,不落盘);dsh=临时 DSH_SESSION_ROOT(工厂建临时目录,stop 清理)。 */
  private createTestProc(
    key: string,
    cwd: string,
    provider: string,
    modelId: string,
    kernel: KernelId,
  ): { proc: SessionProc } {
    const backend = this.factory.create({
      cwd, agentDir: this.agentDir, kernel, neutralSessionId: key, provider, model: modelId, ephemeral: true,
    });
    const proc: SessionProc = {
      backend, kernel, neutralSessionId: key, nonce: randomUUID(), cwd, key, boundSessionPath: null,
      genStartMs: null, lastTps: null, roundOut: 0, roundGenSec: 0,
      turn: zeroTurnUsage(), lastTurn: null, turns: 0, steps: 0, lastPromptAnchorReal: false, touched: false,
      configSnapshot: this.captureConfigSnapshot(backend.configDepPaths ?? []), lastModelRef: null,
      activeLineageId: key, materializedLineageId: key,
    };
    this.bindProcEvents(proc);
    return { proc };
  }

  /** 等 test 会话的 ping 结果:只订阅 key 匹配的 keyed 事件流 + 内核进程事件,超时兜底。 */
  private awaitTestReply(key: string, timeoutMs: number): Promise<ModelTestResult> {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (result: ModelTestResult): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        offKeyed();
        this.kernelListeners.delete(onKernel);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: `timeout ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
      const offKeyed = this.onSessionEvent(key, (event) => {
        if (event.type === "messageEnd") {
          const msg = (event as { message?: NeutralMessage }).message;
          if (msg?.error) return finish({ ok: false, error: extractMessageError(msg) });
          if (msg?.role === "assistant") return finish({ ok: true });
        }
        if (event.type === "agentEnd" || event.type === "agentSettled") {
          finish({ ok: false, error: "no response" });
        }
      });
      const onKernel = (event: KernelEvent): void => {
        if ((event as { sessionKey?: string }).sessionKey !== key) return;
        if (event.kind === "processExit" && !event.expected) {
          finish({ ok: false, error: `process exited (code ${event.code})` });
        }
        if (event.kind === "rpcError") {
          finish({ ok: false, error: event.message });
        }
      };
      this.kernelListeners.add(onKernel);
    });
  }

  async getThinkingLevels(): Promise<string[]> {
    return this.piSend((pi) => pi.getThinkingLevels());
  }

  async setThinkingLevel(level: string): Promise<void> {
    // 根因同 setModel:进程没活不能静默 return(pref flush 被吞),未起则起。
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("会话未启动，请先选择模型");
    // 思考强度是契约意图(§atomic-send):dsh 无此面经 AbstractBackend 缺面默认抛错,不再静默吞。
    // 差量执行同 setModel:进程已持目标档位时同值 RPC 是纯噪声(内核落
    // thinking_level_change 分隔线),跳过;快照缺失(实况未知)回落为必发。
    if (this.latestSnapshot?.state.thinkingLevel !== level) {
      await proc.backend.setThinkingLevel(level);
      // 对称 setModel:thinking_level_change 条目同样被基线守卫挡住 live——直投视图流。
      this.dispatchViewDivider({ type: "thinking_level_change", thinkingLevel: level });
      // 对称 setModel:thinking_level_select 是纯扩展事件,RPC stdout 收不到,主动 sync 取真值。
      void this.sync().catch(() => {});
    } else if (!proc.touched) {
      // 新会话壳:spawn 已落 thinking_level_change,补视图流(同 model_change 根因)。
      this.dispatchViewDivider({ type: "thinking_level_change", thinkingLevel: level });
    }
    // 双写(设计 §4.1):provider/modelId 用快照现值补齐,守 model 域三字段原子替换(§3.2)。
    const model = this.latestSnapshot?.state.model;
    if (this.activeSessionPath && model) {
      await this.writeModelPrefsToHeader(this.activeSessionPath, { provider: model.provider, modelId: model.id, thinkingLevel: level });
    }
  }

  /** 会话统计(内核无关):tps/轮次用量/回合数/步数是壳从事件流自算,对 pi/dsh 都返回;
   *  tokens/userMessages/assistantMessages/toolCalls/toolResults/totalMessages/cost/contextUsage
   *  是基座口径,只有 pi 提供(get_session_stats RPC),dsh 无此面 → 留空(0/undefined),不伪造。 */
  async getStats(): Promise<SessionStats> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("内核未启动");
    const local = { tps: proc.lastTps, turn: proc.turn, lastTurn: proc.lastTurn, turns: proc.turns, steps: proc.steps };
    const pi = proc.backend.capabilities.pi as PiBackendExtensions | undefined;
    if (!pi) return shellSessionStats(local);
    const stats = await pi.getSessionStats(local);
    // 上下文信任序(resolveContextUsage,契约单源):锚不可信(供应商不报 prompt token)时
    // 用 context-probe 的请求侧实测兜底,再无可信来源则诚实未知——不放行内核的假锚点。
    if (!proc.lastPromptAnchorReal) {
      const measured = proc.boundSessionPath ? this.catalog.contextProbeTokens(proc.boundSessionPath) : null;
      stats.contextUsage = resolveContextUsage(stats.contextUsage, false, measured);
    }
    return stats;
  }

  // ============ MessagingApi ============

  async steer(text: string, images?: ImageInput[]): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("会话未启动，请先选择模型");
    await this.asPi(proc).steer(text, images);
    proc.touched = true;
  }

  async followUp(text: string, images?: ImageInput[]): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("会话未启动，请先选择模型");
    await this.asPi(proc).followUp(text, images);
    proc.touched = true;
  }

  async abortRetry(): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) return;
    await this.asPi(proc).abortRetry();
  }

  // ============ ModelApi ============

  async cycleModel(): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("会话未启动，请先选择模型");
    await this.asPi(proc).cycleModel();
  }

  async cycleThinkingLevel(): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("会话未启动，请先选择模型");
    await this.asPi(proc).cycleThinkingLevel();
  }

  // ============ SessionTreeApi ============

  async fork(parentLineageId: string, boundary?: string, position: "before" | "at" = "at"): Promise<string> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("内核未启动");
    // fork = 壳切中立树(§kernel-forkless §14):分叉是壳的纯操作,内核不 fork、不物化。
    // 惰性物化:分支只在下次 send 时经 materializeActiveLineage seed 投影。
    //
    // 父 lineage 用调用方指定的 parentLineageId(根因修复,勿回退):此前硬取
    // proc.activeLineageId,会话树面板里点「非活跃分支」的节点分叉会静默挂到活跃分支上
    // ——分叉关系整个错掉。传入值须存在于中立树,否则显式报错(不静默换父)。
    const cur = this.readNeutral(proc);
    let parent = parentLineageId || proc.activeLineageId;
    if (cur && parentLineageId && !cur.lineages.some((l) => l.lineageId === parentLineageId)) {
      console.warn(`[session-store] fork:父 lineage ${parentLineageId} 不在中立树,回落活跃 lineage ${proc.activeLineageId}`);
      parent = proc.activeLineageId;
    }
    const newLineageId = randomUUID();
    if (cur && this.neutralStore) {
      // 边界归一 + position 截断语义(bookmark-snapshot-fork-unify §4.4):调用方传的 boundary
      // 可能是内核条目 id(老渲染层路径)——先按中立树解析成中立 entryId;"before" 排除锚点
      // (retry/rewind 排除待重发 user 消息,避免同一条 user 在前缀 + 重发各出现一次)。
      const resolvedBoundary = resolveForkBoundary(cur, parent, boundary, position);
      const lineage = { lineageId: newLineageId, fork: { parentLineageId: parent, boundaryEntryId: resolvedBoundary }, entries: [] };
      const next = upsertNeutralLineage(cur, lineage);
      this.putNeutral(next, { ns: proc.neutralSessionId, kind: "lineage", lineage, header: next.header });
    }
    proc.activeLineageId = newLineageId;
    return newLineageId;
  }

  /** 惰性物化(§kernel-forkless §15 + session-single-source §4.4):换分支 = 换投影;
   *  dsh 重开历史会话的新进程 = 同一条路径(新进程空空,首发前回填)。
   *  当前内核物化的 lineage 与活跃 lineage 不一致时,把活跃 lineage 的 seed 投影
   *  (assembleSeedProjection:压缩截断 + role 白名单,契约单源)灌进内核。
   *  幂等:同 lineageId → 同派生 id。 */
  private async materializeActiveLineage(proc: SessionProc): Promise<void> {
    if (proc.materializedLineageId === proc.activeLineageId) return;
    const session = this.readNeutral(proc);
    const lineage = session ? assembleSeedProjection(session, proc.activeLineageId) : [];
    // 空投影(新会话首条/无历史):无内容可 seed,直接标记物化——避免 pi 首条为「空 seed」
    // 白走一遍 stop+spawn 双进程(惰性物化后 materializedLineageId 恒空,须在此短路)。
    if (lineage.length === 0) {
      proc.materializedLineageId = proc.activeLineageId;
      return;
    }
    const seedOpts = {
      kernel: proc.kernel, cwd: proc.cwd, agentDir: this.agentDir,
      neutralSessionId: proc.neutralSessionId, lineageId: proc.activeLineageId,
      header: session?.header ?? { kernel: proc.kernel, cwd: proc.cwd, createdAt: new Date().toISOString() },
    };
    const seedFn = this.factory.seed;
    // RPC seed 面(现进程直接 seed,不 stop+重建=双 spawn 浪费;seed 按 lineageId 幂等):
    // ① factory 无预 seed 函数(测试简化工厂 / 无预 seed 内核)→ 恒现进程 seed;
    // ② factory.seed 对本内核返 null(生产 dsh,能力面探测 !capabilities.pi)→ 现进程 seed。
    // 预 seed 内核(生产 pi,factory.seed 返路径 + capabilities.pi)才走下方 stop+预 seed+spawn。
    if (proc.backend.alive && (seedFn == null || !proc.backend.capabilities.pi)) {
      await proc.backend.seed(lineage, seedOpts);
      proc.materializedLineageId = proc.activeLineageId;
      return;
    }
    await proc.backend.stop();
    const seeded = seedFn ? await seedFn(lineage, seedOpts) : null;
    let newBackend: BaseBackend | null = null;
    let newSessionId: string;
    try {
      if (seeded != null) {
        newSessionId = seeded;
        newBackend = this.factory.create({
          cwd: proc.cwd, agentDir: this.agentDir, kernel: proc.kernel,
          systemPromptPaths: this.getSystemPromptPaths(),
          systemPromptTexts: proc.role ? [roleToPrompt(proc.role)] : undefined,
          neutralSessionId: proc.neutralSessionId,
        });
        await newBackend.start();
      } else {
        newBackend = this.factory.create({
          cwd: proc.cwd, agentDir: this.agentDir, kernel: proc.kernel,
          neutralSessionId: proc.neutralSessionId,
          systemPromptPaths: this.getSystemPromptPaths(),
        });
        await newBackend.start();
        if (lineage.length === 0) {
          // 身份不变量(§4.3):空投影时内核标识必须已在(构造注入),不为空会话拼兜底名。
          const sid = newBackend.sessionId;
          if (!sid) throw new Error("内核未返回会话标识(身份不变量)");
          newSessionId = sid;
        } else {
          newSessionId = await newBackend.seed(lineage, seedOpts);
        }
      }
    } catch (err) {
      // 投影失败收尾(kernel-switch-projection §4.4):新进程已 start 而未挂到 proc.backend,
      // 不 stop 就成孤儿进程(实弹:dsh seed 抛错时旧进程已停、新进程泄漏)。stop 兜底再外抛。
      if (newBackend) await newBackend.stop().catch(() => {});
      throw err;
    }
    proc.backend = newBackend;
    proc.nonce = randomUUID(); // 换绑即换出生证(materialize 重建进程,旧提问走续路)
    proc.boundSessionPath = newBackend.capabilities.pi ? newSessionId : null;
    proc.configSnapshot = this.captureConfigSnapshot(newBackend.configDepPaths ?? []);
    this.bindProcEvents(proc);
    proc.materializedLineageId = proc.activeLineageId;
  }

  async clone(): Promise<void> {
    // clone 归壳(session-single-source §4.2):中立层整树复制 + 新 ns——离线可克隆,
    // 不再需要 pi 进程在线做文件 fork;内核侧下次发送时按新 lineage 惰性 seed(§4.4)。
    const srcNs = this.activeSessionPath ? this.neutralSessionIdFromPath(this.activeSessionPath) : undefined;
    const cur = srcNs ? this.neutralStore?.get(srcNs) : null;
    if (!cur || !this.neutralStore || !this.activeCwd) throw new Error("克隆失败:当前会话无中立层数据");
    const newNs = randomUUID();
    const cloned = cloneNeutralSession(cur, newNs, { name: forkCopyName(cur.header.name), nowIso: new Date().toISOString() });
    this.putNeutral(cloned, { ns: newNs, kind: "session", session: cloned });
    // 切激活到克隆会话:投影地址按源会话内核归属派生(内容型内核=派生路径,惰性内核=裸 id)。
    const catalog = this.catalogFor(cur.header.kernel);
    const rootLineageId = cloned.lineages.find((l) => l.fork === null)?.lineageId ?? newNs;
    const newPath = catalog.projectionPath(this.activeCwd, rootLineageId);
    this.setContext(this.activeCwd, newPath);
    // 克隆后无活进程(惰性 seed 等下次发送)——基线直接从中立层出并广播,
    // renderer 即时看到克隆内容(内容单源:基线不需要活进程)。
    const messages = deduplicateAdjacent(lineageContent(cloned, rootLineageId).map((e) =>
      e.display?.image ? ({ ...e.message, __image: e.display.image } as NeutralMessage) : e.message,
    ));
    const snapshot: SyncSnapshot = {
      ...emptySnapshot(),
      state: { ...emptySnapshot().state, sessionId: newNs, sessionFile: newPath, sessionName: cloned.header.name ?? "" },
      messages,
    };
    this.latestSnapshot = snapshot;
    for (const cb of this.snapshotListeners) {
      try { cb(snapshot); } catch (err) { console.error("[session-store] 快照监听器抛错已隔离:", err); }
    }
  }

  /** 从任意会话分叉(§kernel-forkless §14/§33):书签 fork = 在源会话中立树切一条新 lineage,
   *  不复制文件、不调内核 fork、不新增列表条目。惰性物化:分支只在下次 send 时 seed。 */
  async forkFromSession(cwd: string, srcNs: string, entryId: string, position: "before" | "at" = "at"): Promise<void> {
    if (!srcNs || !this.neutralStore) return; // 源会话无中立层:迁移过渡期静默 no-op
    const cur = this.neutralStore.get(srcNs);
    if (!cur) return;
    const newLineageId = randomUUID();
    const rootLineageId = cur.lineages.find((l) => l.fork === null)?.lineageId ?? srcNs;
    // position 截断语义(bookmark-snapshot-fork-unify §4.4):"before" 排除锚点(排除待重发 user)。
    const resolvedBoundary = resolveForkBoundary(cur, rootLineageId, entryId, position);
    const lineage = { lineageId: newLineageId, fork: { parentLineageId: rootLineageId, boundaryEntryId: resolvedBoundary }, entries: [] };
    const next = upsertNeutralLineage(cur, lineage);
    this.putNeutral(next, { ns: srcNs, kind: "lineage", lineage, header: next.header });
    const proc = this.activeProc();
    if (proc) {
      proc.neutralSessionId = srcNs;
      proc.activeLineageId = newLineageId;
    }
  }

  /** fork/clone 后的对账:内核切换会话文件不推事件(session_start 是纯扩展事件,RPC stdout
   *  永不见;fork 响应也不带新路径),框架须主动 sync 拿 get_state.sessionFile 切激活路径,
   *  并推 synthetic sessionStart 水合 renderer——否则 UI 停在 fork 前路径,
   *  prompt 时 sessionStart 还会把过期路径再播一遍(调用方各自 sync 是补丁且修不到路径)。
   *  rekeyProc 同步把进程条目迁到新路径(key === boundSessionPath 不变量)。
   *  展示元数据经中立层(kernel 版本)承载,fork 走中立层切 lineage,不在此复制。 */
  private async reconcileAfterSessionReplacement(knownNewId?: string): Promise<void> {
    const snapshot = await this.sync();
    // knownNewId:中性契约 fork 返回的不透明 lineage id(pi=新会话文件路径)——壳不再从
    // RPC 状态读 sessionFile;未给(仅 clone 仍走读状态)则回落状态值。
    const sf = knownNewId ?? snapshot.state.sessionFile;
    if (typeof sf !== "string" || !sf || sf === this.activeSessionPath) return;
    this.activeSessionPath = sf;
    const proc = this.activeProc();
    if (proc) this.rekeyProc(proc, sf);
    this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: sf });
  }

  /** 分叉点之前的消息序列(session-single-source §4.2):中立层前缀截取,不再走 pi RPC。
   *  entryId 可能是内核条目 id(老调用方)——先归一为中立坐标再截。 */
  async getForkMessages(entryId: string): Promise<NeutralMessage[]> {
    const proc = this.activeProc();
    const session = proc ? this.readNeutral(proc) : null;
    if (!session || !proc) return [];
    const boundary = resolveBoundaryEntryId(session, proc.activeLineageId, entryId);
    const prefix = materializeLineagePrefix(session, proc.activeLineageId, boundary || entryId);
    if (!prefix) return [];
    return prefix.entries.map((e) => e.message);
  }

  // ============ PiExtensions:维护面(compact/auto/export/lastText) ============

  async compact(customInstructions?: string): Promise<void> {
    await this.piSend((pi) => pi.compact(customInstructions));
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.piSend((pi) => pi.setAutoCompaction(enabled));
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.piSend((pi) => pi.setAutoRetry(enabled));
  }

  async getLastAssistantText(): Promise<string> {
    return this.piSend((pi) => pi.getLastAssistantText());
  }

  // ============ PiExtensions:队列模式(steering/followUp mode) ============

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.piSend((pi) => pi.setSteeringMode(mode));
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.piSend((pi) => pi.setFollowUpMode(mode));
  }

  // ============ BashApi ============

  async run(command: string, opts?: { excludeFromContext?: boolean }): Promise<BashResult> {
    return this.piSend((pi) => pi.bash(command, opts?.excludeFromContext));
  }

  async abortBash(): Promise<void> {
    await this.piSend((pi) => pi.abortBash());
  }

  /** 原样发 RPC 命令(壳内高级用途;插件不暴露,插件走意图方法)。默认作用于激活会话;
   *  target 显式钉进程时用 target(forkFromSession 竞态护栏的唯一消费点——跨 await 的
   *  多步编排不能经环境性 activeProc() 取进程,见该方法注释)。 */
  /** pi 专属命令发送 + rpcError 上报(语义收编后:pi 专属命令经此助手,中性操作走 proc.backend)。 */
  private piSend<T>(fn: (pi: PiBackendExtensions) => Promise<T>, target?: SessionProc): Promise<T> {
    const proc = target ?? this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("pi 未启动");
    const key = target?.key ?? this.activeKey;
    const pi = this.asPi(proc);
    return fn(pi).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const reason = err instanceof Error && (err as { code?: string }).code === "timeout" ? "timeout" : "sendError";
      this.dispatchKernel({ kind: "rpcError", reason, message, sessionKey: key });
      throw err;
    });
  }

  /** 能力探测:取当前后端的 pi 扩展面(pi 专属命令的前提)。dsh 无此面 → 抛错降级。
   *  经 backend.capabilities.pi 探测,不按内核身份硬分支;type-only import 接口、
   *  不 import 具体内核类(§28.6)。 */
  private asPi(proc: SessionProc): PiBackendExtensions {
    const pi = proc.backend.capabilities.pi;
    if (!pi) throw new Error("当前后端不支持 pi 专属命令");
    return pi as PiBackendExtensions;
  }

  /** 事件路由(多会话并存的核心纪律):
   *  - 状态跟踪(busy/TPS/boundSessionPath):按事件来源 key 记账,与激活无关。
   *  - 运维流(dispatchKernel + keyedListeners):激活会话全量;后台会话转非流式增量事件
   *    (agentStart/messageStart/messageEnd/toolCallStart/toolCallEnd/autoRetry与compaction对/
   *    entryAppended/agentEnd/agentSettled/sessionStart,带 sessionKey),仍排除 messageUpdate 与
   *    toolCallUpdate 两个 token 级刷屏源(设计 docs/design/session-working-phase.md §2.2)。
   *    消费方:会话栏经此推后台阶段与未读增量、restart 经 keyedListeners 等。
   *  - 视图流(listeners,即插件的 sessions.onEvent):只转激活会话——后台会话的任何事件
   *    都不得污染当前时间线(此前 messageEnd 全转发,renderer 无 key 可用,会用别的会话的
   *    消息覆盖当前视图末条、用背景会话的 agentSettled 提前熄掉 streaming,见评估 A)。
   *  TPS 自算:messageStart 记时,messageEnd 用 output tokens / 耗时算 tps(内核不给 TPS)。 */
  private dispatch(key: string, event: SessionEvent, kernel?: KernelId): void {
    const k = kernel ?? this.activeKernel;
    const proc = k ? this.procs.get(key)?.get(k) : undefined;
    if (event.type === "sessionStart") {
      const sf = event.sessionFile;
      if (typeof sf === "string" && sf && proc) {
        proc.boundSessionPath = sf;
        // activeSessionPath 只属于激活会话——背景会话的 sessionStart(如重启重载)不得改写
        if (key === this.activeProcKey) this.activeSessionPath = sf;
      }
      // 中立主键随事件携带(根因修复,勿回退):renderer 此前靠 sessionInfos 列表反查
      // neutralSessionId——新会话首次发送时列表未含该会话,查找恒落空,currentNeutralSessionId
      // 留 null 到重开,收藏/分叉按钮(要求 currentNeutralSessionId 非空)全灭。
      // proc 在则取 proc.neutralSessionId;无 proc(setContext 冷激活)按路径 basename 反查
      // (pi 派生路径文件名即 ns;dsh 投影地址裸 lineageId——两内核同一条反查)。
      if (typeof sf === "string" && sf) {
        (event as { neutralSessionId?: string }).neutralSessionId =
          proc?.neutralSessionId ?? this.neutralSessionIdFromPath(sf);
      }
    }
    if (event.type === "entryAppended" && proc) {
      // 上行同步:entryAppended 降级为回填/补漏(session-single-source §4.1)
      this.syncNeutralEntry(proc, event);
      // 注入「执行时模型」到广播事件条目——renderer applyEvent 水合时据此补 message.model,
      // 与中立层(openSession/refresh)读到同一模型,message.model 固定到发送时。
      const entry = (event as { entry?: unknown }).entry;
      if (entry != null) (event as { entry?: unknown }).entry = this.withEntryModel(proc, entry);
      // 内核旁路改模型的回写(session-single-source §4.5):dsh 的 request/header 派生
      // model_change 条目进事件流即写回头域——中立层头域成为模型实况的共享真相源。
      const rawType = (event as { entry?: { type?: unknown } }).entry?.type;
      if (rawType === "model_change" && key === this.activeProcKey && this.activeSessionPath) {
        const e = (event as { entry?: { provider?: unknown; modelId?: unknown } }).entry!;
        if (typeof e.provider === "string" && typeof e.modelId === "string") {
          void this.writeBackModelRef(this.activeSessionPath, e.provider, e.modelId, proc.kernel);
        }
      }
    }
    // pi 的 modelSelect 事件(内核 CLI /model 等旁路)同样回写头域(§4.5,两内核同一条)。
    if (event.type === "modelSelect" && key === this.activeProcKey && this.activeSessionPath) {
      const m = (event as { model?: { provider?: string; id?: string } }).model;
      if (m?.provider && m.id && proc) {
        void this.writeBackModelRef(this.activeSessionPath, m.provider, m.id, proc.kernel);
      }
    }
    // 写穿(§4.1):messageEnd 是内容落盘的主触发——两内核都产出终态 messageEnd,
    // 不再依赖内核落盘回执事件(pi 的 entry_appended 补丁)作为唯一来源。
    if (event.type === "messageEnd" && proc) {
      this.writeThroughMessageEnd(proc, event);
    }
    if (event.type === "sessionInfoChanged" && key === this.activeProcKey) {
      // 基线增量:改名即时反映到 latestSnapshot.state.sessionName——prompt() 的自动命名
      // 判定(无名字才命名)依赖基线新鲜;不走全量 sync(事件驱动,见 §5.3 收敛)。
      // 显式收窄:SessionEvent 联合末尾的宽松兑底成员使 case 判别不自动窄化,与 renderer 同一手法。
      // sessionName 已由 gateway 翻译器规范化(空名→undefined),此处直接赋值。
      const name = (event as { sessionName?: string }).sessionName;
      if (this.latestSnapshot) this.latestSnapshot.state.sessionName = name;
      // 中立层同步记名(根因修复,勿回退):latestSnapshot 是 pi 专属快照面,dsh 恒 null——
      // 内核侧改名(dsh 的 session/title 自动命名)不进中立层时,prompt() 的「还没有名字」
      // 判据永远成立 → 每条消息都重命名一遍(改名分隔线刷屏)。中立层 header.name 是两内核
      // 共享的「是否已命名」真相源,事件到了就记(fire-and-forget,失败下次再写)。
      if (typeof name === "string" && name && this.activeSessionPath) {
        void this.writeNeutralHeader(this.activeSessionPath, { name }).catch(() => {});
      }
    }
    // ask 落账对账(ask-design §4.3):ask_user_question 的 toolCallStart 捕获 toolCallId +
    // 模型原始 questions(真实 q.id 的唯一来源,帧/文件里的 id 是合成物)。
    if (event.type === "toolCallStart" && proc) {
      const toolName = (event as { toolName?: unknown }).toolName;
      if (toolName === "ask_user_question") {
        const tcId = (event as { toolCallId?: unknown }).toolCallId;
        proc.lastAskToolCallId = typeof tcId === "string" && tcId ? tcId : undefined;
        const args = (event as { args?: unknown }).args as { questions?: unknown } | undefined;
        proc.lastAskQuestions = Array.isArray(args?.questions) ? (args.questions as Question[]) : undefined;
      }
    }
    // ask 对账(§5.3):toolCallEnd 命中 pending 记录 → 结算(覆盖 abort 等不经卡片的收尾)。
    if (event.type === "toolCallEnd") {
      const tcId = (event as { toolCallId?: unknown }).toolCallId;
      if (typeof tcId === "string" && tcId) this.settleQuestionByToolCallEnd(tcId, event);
    }
    if (event.type === "agentStart") {
      this.busyStates.set(key, true);
      if (proc) {
        proc.roundOut = 0; proc.roundGenSec = 0;
        // 翻轮:有真实消耗才归档——中止的空轮(无 messageEnd 落地 usage)不抹掉有效历史。
        if (proc.turn.input + proc.turn.output + proc.turn.cacheRead + proc.turn.cacheWrite > 0) {
          proc.lastTurn = proc.turn;
        }
        proc.turn = zeroTurnUsage();
      }
    } else if (event.type === "agentSettled") {
      this.busyStates.set(key, false);
      // 完成回合数:agentSettled 是跨内核中性回合收敛信号(pi agent_settled / dsh turn/end),
      // 只数 agentSettled 不数 agentEnd——pi 两者同帧双发,双数会翻倍,dsh 无 agentEnd。
      if (proc) proc.turns += 1;
      // 回合收敛推一次中立层快照(免 RPC:messages/tree 都是中立层内存投影)——会话树/统计
      // 等快照消费方在回合间不再走旧(此前快照只在 open/switch/切模型时推,树面板停在
      // 会话开场态)。只服务激活会话;无基线(未 sync 过)不推,等首个真基线。
      if (key === this.activeProcKey && proc && this.latestSnapshot) {
        const snapshot: SyncSnapshot = {
          ...this.latestSnapshot,
          state: { ...this.latestSnapshot.state, isStreaming: false, messageCount: this.neutralMessagesOf(proc).length },
          messages: this.neutralMessagesOf(proc),
          tree: this.neutralTreeOf(proc),
        };
        this.latestSnapshot = snapshot;
        for (const cb of this.snapshotListeners) {
          try { cb(snapshot); } catch (err) { console.error("[session-store] 快照监听器抛错已隔离:", err); }
        }
      }
    } else if (event.type === "autoRetryStart") {
      this.busyStates.set(key, true);
    } else if (event.type === "autoRetryEnd") {
      // success=true:恢复生成,收尾交 agentSettled;false/取消:重试终结,清算。
      if ((event as { success?: boolean }).success !== true) this.busyStates.set(key, false);
    } else if (event.type === "compactionStart") {
      this.busyStates.set(key, true);
    } else if (event.type === "compactionEnd") {
      this.busyStates.set(key, false);
      // 压缩边界条目落中立层(session-single-source §4.1 压缩感知):中立层不靠读内核文件
      // 感知压缩点,靠事件。条目形状与文件读路径同一映射(sessionEntryToNeutral,契约单源);
      // 事件带摘要则记(作 seed 投影的截断代身),不带则只记边界。
      if (proc) {
        const payload = event as { summary?: unknown; tokensBefore?: unknown };
        const synthetic = sessionEntryToNeutral({
          type: "compaction",
          id: `comp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
          ...(typeof payload.tokensBefore === "number" ? { tokensBefore: payload.tokensBefore } : {}),
        });
        if (synthetic) this.appendNeutral(proc, { neutralEntryId: "", message: synthetic });
      }
    }
    if (proc) {
      if (event.type === "messageStart") {
        proc.genStartMs = Date.now();
        // 双写降级账补写(§4.5):内核处理了消息即会话文件必已落盘,
        // 此前因文件未建而降级的模型偏好在此补写清账(幂等,失败仍降级)。
        if (proc.pendingModelPrefs && proc.boundSessionPath) {
          const prefs = proc.pendingModelPrefs;
          const path = proc.boundSessionPath;
          proc.pendingModelPrefs = undefined;
          void this.writeModelPrefsToHeader(path, prefs);
        }
      } else if (event.type === "messageEnd" && proc.genStartMs != null) {
        const elapsed = (Date.now() - proc.genStartMs) / 1000;
        const u = messageUsageOf(event.message);
        const out = u?.tokens.output ?? 0;
        proc.roundOut += out;
        proc.roundGenSec += elapsed;
        proc.lastTps = proc.roundGenSec > 0 && proc.roundOut > 0 ? proc.roundOut / proc.roundGenSec : null;
        proc.genStartMs = null;
        if (u) {
          proc.turn.input += u.tokens.input; proc.turn.output += u.tokens.output;
          proc.turn.cacheRead += u.tokens.cacheRead; proc.turn.cacheWrite += u.tokens.cacheWrite;
          proc.turn.cost += u.cost;
          const m = event.message as { role?: unknown; stopReason?: unknown };
          if (m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error") {
            proc.lastPromptAnchorReal = u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite > 0;
          }
        }
      } else if (event.type === "stepEnd") {
        // 完成步数:stepEnd 是跨内核中性单次模型调用收敛信号(pi turn_end / dsh step/end)。
        proc.steps += 1;
      }
    }
    // 运维流:激活全量、后台转非流式增量(设计 docs/design/session-working-phase.md §2.2;
    // 白名单仍排除 messageUpdate/toolCallUpdate 两个 token 级刷屏源)
    const isBackgroundEvent =
      event.type === "agentStart" ||
      event.type === "messageStart" ||
      event.type === "messageEnd" ||
      event.type === "toolCallStart" ||
      event.type === "toolCallEnd" ||
      event.type === "autoRetryStart" ||
      event.type === "autoRetryEnd" ||
      event.type === "compactionStart" ||
      event.type === "compactionEnd" ||
      event.type === "entryAppended" ||
      event.type === "agentEnd" ||
      event.type === "agentSettled" ||
      event.type === "sessionStart";
    if (key === this.activeProcKey || isBackgroundEvent) {
      this.dispatchKernel({ kind: "session", sessionKey: key, event });
    }
    for (const cb of this.keyedListeners) {
      try { cb(event, key); } catch (err) { console.error("[session-store] keyed 监听器抛错已隔离:", err); }
    }
    // 视图流:仅激活会话
    if (key !== this.activeProcKey) return;
    for (const cb of this.listeners) {
      try { cb(event); } catch (err) { console.error("[session-store] 事件监听器抛错已隔离:", err); }
    }
  }

  private dispatchKernel(event: KernelEvent): void {
    for (const cb of this.kernelListeners) {
      try { cb(event); } catch (err) { console.error("[session-store] kernel event 监听器抛错已隔离:", err); }
    }
  }

  // ============ SessionStoreForRestart(§6.6) ============

  isBusy(sessionKey: string): boolean {
    return this.busyStates.get(sessionKey) ?? false;
  }

  onSessionEvent(sessionKey: string, cb: (event: SessionEvent) => void): () => void {
    // 按事件来源 key 过滤(此前错拿 activeProcKey 比,后台会话的订阅永远不触发,
    // restart-coordinator 等空闲永远等不到 agentSettled——根因修复,勿回退)。
    const wrapper = (event: SessionEvent, key: string) => {
      if (key === sessionKey) cb(event);
    };
    this.keyedListeners.add(wrapper);
    return () => { this.keyedListeners.delete(wrapper); };
  }

  getRunningSessionKeys(): string[] {
    return [...this.procs.keys()].filter((k) => {
      const kernels = this.procs.get(k);
      return kernels ? [...kernels.values()].some((p) => p.backend.alive) : false;
    });
  }

  async restart(sessionKey: string): Promise<void> {
    const kernels = this.procs.get(sessionKey);
    if (!kernels) return;
    const procs = [...kernels.values()];
    await this.stop(sessionKey);
    // 与 start() 同一装配入口:createProc 绑定全部事件(含 extensionUI/processExit)。
    // neutralSessionId 沿用各内核 proc 的(重启不换主键)。多槽位:逐个内核重启。
    for (const proc of procs) {
      const newProc = this.createProc(sessionKey, proc.cwd, proc.boundSessionPath, false, proc.kernel, undefined, proc.neutralSessionId);
      let ks = this.procs.get(sessionKey);
      if (!ks) { ks = new Map(); this.procs.set(sessionKey, ks); }
      ks.set(proc.kernel, newProc);
      await newProc.backend.start();
    }
    // 只有重启的是激活会话才重推基线;后台会话重启不打扰当前视图,
    // 且 activeProc 没 alive 时 sync 会 throw 被误判为 restart 失败。
    if (sessionKey === this.activeProcKey) await this.sync();
  }

  getCwdAndSessionPath(sessionKey: string): { cwd: string; sessionPath: string | null } {
    const kernels = this.procs.get(sessionKey);
    const proc = kernels ? [...kernels.values()][0] : undefined;
    if (!proc) return { cwd: "", sessionPath: null };
    return { cwd: proc.cwd, sessionPath: proc.boundSessionPath };
  }

  // ============ Session Bus 支撑(路由器经此面驱动任意会话,不涉及激活语义) ============

  /** 全会话事件订阅(带来源 key;keyedListeners 的通用暴露——总线路由器的进线)。 */
  onAnySessionEvent(cb: (event: SessionEvent, sessionKey: string) => void): () => void {
    this.keyedListeners.add(cb);
    return () => { this.keyedListeners.delete(cb); };
  }

  /** $bus 上行帧订阅(createProc 已为每条 backend 绑好转发)。 */
  onBusFrame(cb: (frame: Record<string, unknown>, sessionKey: string) => void): () => void {
    this.busFrameListeners.add(cb);
    return () => { this.busFrameListeners.delete(cb); };
  }

  /** 按 key 取 pi 扩展面(进程不在或非 pi 内核返回 undefined)。 */
  getAdapter(sessionKey: string): PiBackendExtensions | undefined {
    return this.procs.get(sessionKey)?.get(KERNEL_IDS[0])?.backend.capabilities.pi as PiBackendExtensions | undefined;
  }

  /** 按 key 取中性后端(bus 会话恒为 pi 槽位——spawnSession/reopenSession 显式以 pi 建;
   *  不读全局 activeKernel,避免主会话是 dsh 时 bus 落空)。进程不在返回 undefined。 */
  getBackend(sessionKey: string): BaseBackend | undefined {
    return this.procs.get(sessionKey)?.get(KERNEL_IDS[0])?.backend;
  }

  /** 当前激活会话后端的扩展能力面 + 内核归属(renderer 据以显式降级)。
   *  无激活进程(刷新后只 setContext 未起后端)时,内核归属与锁定从持久中立层读回——
   *  不能回落 null/未锁定,否则「刷新后又能换内核」,与「会话已固定内核」矛盾。 */
  getCapabilities(): SessionCapabilities {
    const proc = this.activeProc();
    if (proc) return this.sessionCapabilitiesOf(proc);
    return {
      kernel: this.activeSessionKernel(),
      locked: this.activeSessionHasHistory(),
      piExtension: false,
      dshExtension: false,
    };
  }

  /** 从进程探测扩展能力面 + 内核归属(§7.6:经 capabilities 探测,不按内核身份硬分支)。
   *  locked 判据与 setModel 的跨内核降级一致(§3.2):活跃进程且发过消息即锁定——
   *  保证 renderer 置灰与主侧拒绝同步,不出现「UI 置灰了但能切 / UI 没置灰却切不动」。 */
  private sessionCapabilitiesOf(proc: SessionProc | undefined): SessionCapabilities {
    return {
      kernel: proc?.kernel ?? null,
      locked: !!(proc?.backend.alive && proc?.touched),
      piExtension: proc?.backend.capabilities.pi != null,
      dshExtension: proc?.backend.capabilities.dsh != null,
    };
  }

  /** 能力面变化广播(§7.6 push 收口):renderer 订阅 capabilitiesChanged 一次到位,
   *  不再在每个生命周期转变处散拉式 refreshCapabilities(拉式缓存失同步的根因)。
   *  在会改变 SessionCapabilities 的转变后调用:会话打开/新建、模型切换、内核就绪、首发送锁定。 */
  private broadcastCapabilities(proc: SessionProc | undefined): void {
    this.dispatchKernel({
      kind: "capabilitiesChanged",
      sessionKey: proc?.key ?? this.activeProcKey ?? "",
      capabilities: this.sessionCapabilitiesOf(proc),
    });
  }

  /** 激活会话持久记录的内核归属(中立层 header.kernel);无记录/无中立层返回 null。 */
  private activeSessionKernel(): KernelId | null {
    const ns = this.activeSessionPath ? this.neutralSessionIdFromPath(this.activeSessionPath) : undefined;
    if (!ns || !this.neutralStore) return null;
    return this.neutralStore.get(ns)?.header.kernel ?? null;
  }

  /** 激活会话是否已有持久历史(中立层任一 lineage 有 entry)——「会话已固定内核」的持久真相,
   *  不依赖进程内存态(刷新后进程未起、touched 恒 false,仍应判有历史)。 */
  private activeSessionHasHistory(): boolean {
    const ns = this.activeSessionPath ? this.neutralSessionIdFromPath(this.activeSessionPath) : undefined;
    if (!ns || !this.neutralStore) return false;
    const session = this.neutralStore.get(ns);
    return session ? session.lineages.some((l) => l.entries.length > 0) : false;
  }

  /** 总线 spawn:起一个不抢激活语义的会话进程(key=bus:<uuid8>,全新会话文件)。
   *  opts.role:会话级角色卡——role 文本内联进 argv(--append-system-prompt),createProc 注入。 */
  async spawnSession(cwd: string, opts?: { role?: SessionRole }): Promise<{ key: string; sessionPath: string }> {
    const key = `bus:${randomUUID().slice(0, 8)}`;
    const sessionPath = this.newPiSessionPath(cwd);
    // 新会话路径文件名即 ns(§12.2),反查主键传给 createProc,避免 ns 与路径文件名不一致。
    const ns = this.neutralSessionIdFromPath(sessionPath) ?? randomUUID();
    const proc = this.createProc(key, cwd, sessionPath, false, "pi", opts?.role, ns);
    let kernels = this.procs.get(key);
    if (!kernels) { kernels = new Map(); this.procs.set(key, kernels); }
    kernels.set(proc.kernel, proc);
    await proc.backend.start();
    return { key, sessionPath };
  }

  /** agentDir 只读暴露:总线会话文件路径圈禁用(agentDir 由 shell 注入,本层不直读环境)。 */
  get agentDirPath(): string {
    return this.agentDir;
  }

  /** 总线续聊:以已有会话文件起进程续上下文(不抢激活语义,key=bus:<uuid8>)。
   *  与 spawnSession 的唯一差异:传已有 sessionPath(--session 续上下文)而非新文件。
   *  role 是进程参数(不持久化在会话文件里)——谁 reopen 谁负责带角色;会话历史已含角色
   *  影响,即使不重传也不会完全失忆。
   *  消费方:对话面板对已完成/离线的子 agent "继续对话"(reopen 后 tap 流式回复)。 */
  async reopenSession(cwd: string, sessionPath: string, role?: SessionRole): Promise<{ key: string; sessionPath: string }> {
    const key = `bus:${randomUUID().slice(0, 8)}`;
    const ns = this.neutralSessionIdFromPath(sessionPath);
    const proc = this.createProc(key, cwd, sessionPath, false, "pi", role, ns);
    let kernels = this.procs.get(key);
    if (!kernels) { kernels = new Map(); this.procs.set(key, kernels); }
    kernels.set(proc.kernel, proc);
    await proc.backend.start();
    return { key, sessionPath };
  }

  /** 往指定会话注入一条 prompt(streamingBehavior 由调用方按帧型分派:响应=steer,事件=followUp)。 */
  async sendPromptTo(sessionKey: string, text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    const proc = this.procs.get(sessionKey)?.get(KERNEL_IDS[0]);
    if (!proc || !proc.backend.alive) throw new Error(`会话不在线: ${sessionKey}`);
    await this.asPi(proc).sendMessage(text, undefined, streamingBehavior);
    proc.touched = true;
  }

  /** 按 key 取最后一条 assistant 文本(完成采集主源;进程不在返回空串,调用方回退读文件)。 */
  async getLastAssistantTextFor(sessionKey: string): Promise<string> {
    const proc = this.procs.get(sessionKey)?.get(KERNEL_IDS[0]);
    if (!proc || !proc.backend.alive) return "";
    // 内核命令级失败(backend reject)同样回退空串——本方法是采集主源,读文件兜底在调用方
    return this.asPi(proc).getLastAssistantText().catch(() => "");
  }
}

/** 从带 error 标记的 NeutralMessage 里提取可读错误原语(errorMessage/stopReason 透传字段)。 */
function extractMessageError(message: NeutralMessage): string {
  const m = message as Record<string, unknown>;
  if (typeof m.errorMessage === "string" && m.errorMessage) return m.errorMessage;
  if (typeof m.stopReason === "string" && m.stopReason) return m.stopReason;
  return "model error";
}
