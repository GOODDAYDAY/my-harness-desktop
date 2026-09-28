// 圆心:内核后端契约 —— 把「内核该提供什么」抽成中性接口,pi 和 dsh 各是一个实现。
//
// 依据 docs/design/base-interface-lineage.md §2。圆心只定义接口形状 + 中性类型,
// 实现归 client/pi(pi 后端)与将来的 client/dsh(dsh 后端)——依赖倒置,内层拥有抽象。
//
// 设计锚点(§2.1):抽的是语义层(桌面需要内核提供哪些操作),不是传输层(消息怎么一行行传)。
// 传输(JSONL / JSON-RPC)、增量拉取、行帧、id 配对,都是后端私有,不进本契约。
//
// 不变量(§2.6):
// - 存储退进后端:桌面不读任何一方的存储格式,只认中性事件与 LineageTree。
// - fork 锚点必须是回合边界:pi 的「只接受 user 锚点」与 dsh 的「boundary 不落 open turn」,
//   在本契约归一为「boundary 指向父 lineage 里一个完整回合之后的位置」。

import type { SessionEvent, TreeNode, NeutralMessage, ModelInfo, ProjectStats, TurnUsage, SessionStats, SyncSnapshot } from "./events/session-state";
import type { QuestionAnswer, Question } from "./events/kernel-event";
import type { ImageInput, KnownToolInfo, SessionInfo, SessionDetail, HeaderPatch, SessionToolConfig, BashResult, ConcurrencyMode } from "./sessions";
import type { KernelId } from "./kernel";
import type { NeutralAnchor, NeutralSession, NeutralEntry, NeutralSessionHeader } from "./session-neutral";

/**
 * 分叉点引用:不透明字符串。pi 后端把它当 entryId,dsh 后端把它当 seq 的字符串化。
 * 语义上它总指向「父 lineage 里一个完整回合之后的位置」——两个内核各自的锚点表示,
 * 归一成同一个不透明引用。桌面不解析它的内容,只当 token 在 fork/bookmark/resume 间回传。
 */
export type BoundaryRef = string;

/** 一条 lineage 在父 lineage 上的分叉位置。根 lineage 无父,没有此结构。 */
export interface LineageFork {
  /** 父 lineage 的 id。 */
  parentLineageId: string;
  /** 在父 lineage 上的分叉位置(不透明;pi=entryId,dsh=seq)。 */
  boundary: BoundaryRef;
}

/** 一条 lineage:一条有序事件流 + 一个分叉点。根 lineage 的 fork 为 null。 */
export interface Lineage {
  /** 后端自留的 lineage 标识(pi=分支锚点条目 id,dsh=子会话 id)。桌面当不透明 id 用。 */
  id: string;
  /** 从哪条父 lineage 的哪个位置切出来;null = 根 lineage。 */
  fork: LineageFork | null;
}

/** 一个会话的全部 lineage(含根)。父子关系由各 lineage.fork.parentLineageId 导出。 */
export interface LineageTree {
  /** 根 lineage 的 id。 */
  rootId: string;
  /** 含 root 在内的全部 lineage。 */
  lineages: Lineage[];
}

/** 书签锚点 = 中立坐标(session-neutral-layer.md §6)。契约单源在 session-neutral.ts,此处 re-export 兼容既有 import。 */
export type Anchor = NeutralAnchor;

/** seed 的入参(§kernel-forkless §21):把一条 lineage 的完整线性内容投影到内核。
 *  lineageId 是唯一身份,内核侧会话标识派生自它(§12.2,幂等)。 */
export interface SeedOptions {
  neutralSessionId: string;
  lineageId: string;
  header: NeutralSessionHeader;
}

/**
 * 内核后端:一个可整体替换的内核实现。五个会话分支操作(§2.4)是核心,
 * 消息 / 模型 / 中断是另一块两边现成的接口面,一并收进契约但不展开细节。
 *
 * 实现方义务:
 * - 内核是单线执行器(§kernel-forkless):只物化当前活跃那条 lineage,分叉是壳在中立层的纯操作。
 * - anchor 天然按后端划界:本后端建的锚点只能本后端 resume,收到别家锚点报错。
 */
export interface BaseBackend {
  /** 内核身份(pi/dsh)。跟着实现走,不散在 SessionProc——身份与实现同一处。 */
  readonly kernel: KernelId;

  /** 子进程是否存活。 */
  readonly alive: boolean;

  /** 当前内核侧会话标识(pi=JSONL 文件路径,dsh=不透明 session id/桶名)。null=尚未确定
   *  (如 pi 在 spawn 前/临时会话)。壳经此读取,不自行按内核身份拼内核会话 id。 */
  readonly sessionId: string | null;

  /** 起内核子进程(按需;实现自定 spawn 参数)。 */
  start(): Promise<void>;

  /** 停内核子进程。 */
  stop(): Promise<void>;

  /** 订阅中性事件流(驱动 timeline)。返回取消函数。 */
  onEvent(cb: (event: SessionEvent) => void): () => void;

  /** §2.4.2 拿一个会话的全部 lineage 及父子/分叉点关系。 */
  getTree(sessionId: string): Promise<LineageTree>;

  /** §2.4.3 拿一条 lineage 的线性消息序列(重放历史;timeline/git-review/token-stats 消费)。 */
  getEntries(lineageId: string): Promise<NeutralMessage[]>;

  /** §2.4.4 把一个分叉点持久化成可重启锚点。 */
  bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor>;

  // ⚠ 此处曾有可选成员 `resume?(anchor: Anchor): Promise<string>`（"从锚点重启一条 lineage"），
  //   r72 删除。删除依据（三条都是实测，不是推断）：
  //   ① 全仓搜索 `backend.resume` / `resume?.(` / `resume &&` 等**全部调用形态**，
  //      唯一命中是这个成员自己的注释——即契约声称"壳经 backend.resume? 探测"，而壳从没探测过；
  //   ② 壳的锚点重启走的是 `SessionStore.resume(snapshotId)`：它用快照里的 lineage entries
  //      在**中立层**派生一个新会话（deriveSession），对所有内核一律适用，
  //      不需要任何内核提供"服务端回切"面——所以这个抽象**没有消费方**；
  //   ③ 只有 dsh 实现了它（走 DSH_METHODS.sessionResume），于是它同时是
  //      "死契约成员"与"内核间的功能不对称"（§1.5：内核同等地位、同等功能）。
  //   为什么不是"改注释说明它没用"而是删掉：死契约成员**有害**——它与 r46/r47 的死能力轴同理，
  //   读者（以及第五个内核的实现者）会以为必须实现它、以为壳会探测它。
  //   没有消费方的抽象不是抽象，是猜测（§1.5「内核先抽象后实现」的前提是壳真的需要这个面）。
  //   若将来壳确实需要"内核服务端回切"（例如中立层派生无法表达某内核的语义），
  //   按 §1.5 重新走一遍：先落契约、再各内核实现或显式降级，并**同时**接上消费方。

  /** 删除一个书签锚点(回收后端自留的副本)。非 pi 后端若不支持可抛错。 */
  deleteBookmark(anchor: Anchor): Promise<void>;

  /** 发一条用户消息(唯一会起进程的入口;resolve 只代表内核接受,输出靠事件流)。 */
  sendMessage(text: string, images?: ImageInput[]): Promise<void>;

  /** 中断当前生成。 */
  abort(): Promise<void>;

  /** 切模型。 */
  setModel(provider: string, modelId: string): Promise<void>;

  /** 能力轴:运行时切模型对本后端已物化的会话是否生效(docs/model-switching.md §11.2)。
   *  乐观默认 true——setModel 本是必实现契约;内核/运行时无热切能力时置 false(如 dsh
   *  旧运行时缺 session/setModel,懒探测记缺面后翻转),壳据此让「模型失配」回落停旧
   *  起新,而不是盲目 RPC。 */
  readonly supportsRuntimeSetModel: boolean;

  /** 设置思考强度档位(会话级状态,与 setModel 同级)。可缺面:pi=set_thinking_level RPC;
   *  dsh 无运行时切换(reasoningEffort 只在 initialize/settings.yaml 定)→ 显式降级抛错。
   *  设计 docs/design/atomic-send.md §3。 */
  setThinkingLevel(level: string): Promise<void>;

  /** 命名当前会话(中立命名意图,§2.4 之外的第七意图——会话元数据)。
   *  pi=set_session_name RPC,dsh=session/rename RPC。壳经此命名,不再经 pi 扩展面(capabilities.extensions)。 */
  setSessionName(name: string): Promise<void>;

  /** §kernel-forkless §21:seed 单线投影——把「活跃 lineage 的完整线性内容」物化到内核,
   *  返回内核侧会话标识(§12.2 派生自 lineageId,幂等)。内核是单线执行器,只物化一条 lineage。 */
  seed(lineage: NeutralEntry[], opts: SeedOptions): Promise<string>;

  /** 工具清单(可缺面):返回本内核当前可用工具;null = 内核不支持工具发现,壳走降级。
   *  pi=known-tools 播报文件读取,dsh=将来经 SDK server session/listTools。 */
  listTools?(): Promise<KnownToolInfo[] | null>;

  /** 切工具集(可缺面):把壳下发的工具配置(§5.6.1)热应用到活跃会话。缺面(未实现)时
   *  壳经 SessionToolConfig 文件投影(updateHeader)落盘、下次 spawn 生效——热切是补面。
   *  翻译归内核(enabledToolIds → 自己的工具集语义),壳不感知内核的工具集名。
   *  minimal=setTools 协议命令(适配器翻译);pi/dsh 无此面(缺面)。 */
  setTools?(config: SessionToolConfig): Promise<void>;

  /** 崩溃收尾(可缺面,§4.6.3 壳的机制):注册进程退出回调,壳经此广播 processExit、
   *  清理 session-bus、允许重开。缺面(未实现)时壳走降级——下次发送查 alive 检测死进程。
   *  pi/minimal 实现;dsh 可补面。命名避让 pi 扩展面的 onProcessExit 属性(已改名 onExit)。 */
  onProcessExit?(cb: (exit: ProcessExitInfo, expected: boolean, stderr: string) => void): void;

  /** 回答一次交互式提问(可缺面):把用户答案回填给内核。questionId 由内核铸造。
   *  pi=extension_ui_response 帧翻译,dsh=文件侧车(阶段一)/session/answer(阶段二)。 */
  answerQuestion?(questionId: string, answers: QuestionAnswer[]): Promise<void>;

  /** 能力探测面(§7.6):**按语义轴分面**,能力名中性、不带内核名(§kernel-plugin §6)。
   *  壳经 `backend.capabilities.<轴>` 探测「有则用、无则降级」,不按内核身份硬分支。
   *  各轴的含义、谁有谁没有、无此面时壳怎么降级,见 `BackendCapabilities` 的定义处。 */
  readonly capabilities: BackendCapabilities;

  /** 内核 spawn 时读取的配置文件绝对路径清单——这些文件变了壳需重建进程
   *  (内核模型/配置快照 spawn 时定型,运行中不重读)。pi=models.json/settings.json;
   *  dsh=settings.yaml/cordis.yml。缺省 [](无依赖)。中性契约:壳不硬编码内核文件名。 */
  readonly configDepPaths?: string[];
}

/** 进程退出信息(中性，替代 client 侧 ProcessExit，避免圆心依赖 client)。 */
export interface ProcessExitInfo {
  code: number | null;
  signal: string | null;
}

/**
 * 思考档位能力面(§7.6)：内核的思考档位运行时能力探测面，无此面的内核 = undefined。
 * 懒探测：装上的内核版本可能缺某些 session/* 方法，首次调用失败(unknown method)时
 * 记录进 missing，之后壳据此显式降级——不静默、不伪造成功(docs/design/dsh-capability-gate.md)。
 */
export interface ThinkingCapabilities {
  /** 新缺面发现回调(壳绑定后广播降级事件，驱动 UI 置灰入口)。
   *  可选：只有「懒探测」的内核需要它(dsh 装上的适配插件版本可能缺某些 session/* 方法，
   *  首次调用失败时记录并上报)。方法恒在的内核(pi)不声明。
   *  ⚠ 此处曾有 `readonly missing: ReadonlySet<string>`——**只被 dsh 自己读**、壳从不消费，
   *  属死契约面，已删；缺面清单是 dsh 的私有状态(`missingMethods`)，不需要进圆心。 */
  onMissing?: ((method: string) => void) | null;
  /** 思考档位清单查询(补面，docs/design/dsh-thinking-level.md)：桌面适配插件拦截
   *  session/getThinkingLevels 提供;旧版适配插件无此面 → 调用时懒探测记缺面、
   *  壳据此显式降级(藏档位控件),不静默、不伪造成功。 */
  getThinkingLevels?: () => Promise<string[]>;
  /** 循环切到下一档位。有清单查询面而无此面的内核 = 只能查不能轮转,壳/renderer 据此
   *  把「运行时切档」入口置灰并给真实原因(不是笼统置灰整个思考域)。 */
  cycleThinkingLevel?: () => Promise<void>;
  /** 清单语义 —— 决定「`getThinkingLevels()` 返回空」该怎么解读:
   *  - `precise`(缺省):内核给的是**当前模型**支持的精确清单,空 = 该模型无档位,
   *    渲染层必须如实不渲染,**不许**拿默认清单伪造可切(§1.5 不伪造成功);
   *  - `approximate`:内核给的是全局档位表,且可能因 RPC 响应形状不识别而返空
   *    (pi 的 `getThinkingLevels` 在 `data.levels` 形状不符时返回 `[]`,
   *    `pi-backend.ts:306-313`),渲染层可回落到已知默认清单。
   *  **为什么要这个字段**:此前渲染层用「有没有 pi 扩展面」来区分这两种语义
   *  (`capabilities.extension ? 回落默认 : 如实不渲染`),那是拿内核身份当语义代理;
   *  分面之后两个内核都有 thinking 面,区分必须由内核**自己声明**,第四个内核也能自报。 */
  levelsSemantics?: "precise" | "approximate";
}

/** 并发档位:`steer`=插话(立即影响当前回合) / `followUp`=排队(当前回合结束后处理)。 */
export type StreamingBehavior = "steer" | "followUp";
// `ConcurrencyMode` 的单源在 `./sessions`（`MessagingApi` 与 `SteeringCapabilities` 共用），
// 本文件经 import 复用、不再另定义一份——同一概念两份定义必然漂移（§1.3）。

/**
 * 多路并发面(§7.6 三分法里的「显式降级」轴)。
 * 谁有:pi 有;dsh **无多路并发**(`docs/design/kernel-parity-audit.md:59`「➖ pi 扩展面,降级」)。
 * 无此面的内核:壳走契约的 `sendMessage`(每个内核必实现),代价是「不分 steer/followUp 档位」,
 * 不是「收不到帧」——后者才是不可接受的(见 `session-store.sendPromptTo` 的降级说明)。
 */
export interface SteeringCapabilities {
  steer(text: string, images?: ImageInput[]): Promise<void>;
  followUp(text: string, images?: ImageInput[]): Promise<void>;
  setSteeringMode(mode: ConcurrencyMode): Promise<void>;
  setFollowUpMode(mode: ConcurrencyMode): Promise<void>;
  /** 带并发档位的发送。无此面 → 壳回落到契约 `sendMessage`(不分档)。 */
  sendMessage(text: string, images?: ImageInput[], behavior?: StreamingBehavior): Promise<void>;
}

/**
 * 重试面:中断正在进行的重试、开关自动重试。
 * 谁有:pi 有;dsh 的 `llm/retry` **事件已转发**、配置面尚未对齐
 * (`docs/design/kernel-parity-audit.md:87` 列为 P1 剩余)——所以它是**可补**的面,不是永久专属。
 */
export interface RetryCapabilities {
  abortRetry(): Promise<void>;
  setAutoRetry(enabled: boolean): Promise<void>;
}

/**
 * 压缩面:手动触发上下文压缩、开关自动压缩。
 * 谁有:pi 有(`compact` RPC);dsh 经 `compaction-basic` 插件只有**自动**压缩,手动触发面缺
 * (`docs/design/kernel-parity-audit.md:80`「⚠️ 手动触发面缺」)——同为可补的面。
 */
export interface CompactionCapabilities {
  compact(customInstructions?: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
}

/**
 * 快照面:能从**内核实况**拉回一份状态快照。
 * 谁有:pi 有(并发拉 state+entries+tree+commands 组装中性快照);dsh 无——它的会话真相源在
 * 内核进程内,状态由**壳记账 + 中立头组装**(`session-store.sync` 的无快照面分支)。
 * 这条轴还决定「模型是否已生效」的真相源:有快照面读快照,无快照面读壳侧账本
 * `effectiveModel`(`docs/model-switching.md` §11.3 那个根因)。
 */
export interface SnapshotCapabilities {
  resync(): Promise<SyncSnapshot>;
  /** 最近一条 assistant 文本(无则空串)。盲评/复盘类插件用它取内核实际产出。 */
  getLastAssistantText(): Promise<string>;
}

/**
 * 会话统计面:**内核侧口径**的 tokens / cost / contextUsage。
 * 谁有:pi 有(`get_session_stats` RPC);dsh 无此面 → 壳只给自算部分
 * (tps / 轮次用量 / 回合数 / 步数),其余留空(0/undefined)**不伪造**。
 */
export interface StatsCapabilities {
  getSessionStats(local: {
    tps: number | null; turn: TurnUsage; lastTurn: TurnUsage | null; turns: number; steps: number;
  }): Promise<SessionStats>;
}

/**
 * 模型循环面:在**内核自己的**模型清单里轮转,以及读回该清单。
 * 谁有:pi 有(`cycle_model` RPC,轮转顺序是**内核私有**语义)。
 *
 * ⚠ **本面与快捷键的"循环切换模型"不是同一个操作**（r25 实测澄清；此前这里的注释说
 * "壳自行轮转属行为变更、本次不做"，而壳其实早就在自行轮转了，陈述已过时且会误导）：
 *
 * | | 本面（`cycleModel`） | 快捷键 `timeline:cycleModel` |
 * |---|---|---|
 * | 轮转范围 | **单个内核**自己的清单 | **跨内核**的合流清单（`ModelCatalog`） |
 * | 顺序由谁定 | 内核私有语义（pi 的 `cycle_model`） | 壳按合流清单的次序推导 |
 * | 触发路径 | `IPC.session.cycleModel` → `SessionStore.cycleModel()` → `faceOf(proc,"modelCycle")` | 默认键位 `mod+shift+]` / `mod+shift+[` → timeline 的 channel |
 * | 当前生产消费者 | **零**（无插件调用 `ctx.sessions.cycleModel()`） | 快捷键（唯一实际在用的轮转） |
 *
 * 所以：**不要把快捷键改成走本面**——那会失去跨内核轮转（内核不知道别的内核有哪些模型），
 * 是功能退化而不是"归位"。本面保留是给插件用的能力面（"在当前内核内轮换"这个语义
 * 壳无法代劳，因为顺序是内核私有的）。它当前无消费者这一点由
 * `src/capability-axis-consumers.test.ts` 显式声明并守卫（分类为"服务端强制"，附理由），
 * 不是被遗忘——将来若有插件要用，那条守卫会要求把分类改过来。
 */
export interface ModelCycleCapabilities {
  cycleModel(): Promise<void>;
  getModels(): Promise<ModelInfo[]>;
}

/**
 * 工具执行面:直投一条 shell 命令并取回结果、中断正在跑的 bash。
 * 谁有:pi 有(调用方需声明 `rpc:bash` 权限);无此面的内核 → 壳置灰该入口。
 */
export interface ToolExecCapabilities {
  bash(command: string, excludeFromContext?: boolean): Promise<BashResult>;
  /** 中断正在跑的 bash。返回内核的原始 ack(调用方不消费),故为 unknown 而非 void——
   *  与内核实现的真实返回对齐,不借契约收窄逼迫实现丢弃它已有的返回值。 */
  abortBash(): Promise<unknown>;
}

/**
 * bus 上行帧通道面:内核侧插件往壳的会话总线投递的原始帧。
 * 谁有:pi 有(`$bus` 上行帧透传);无此面的内核 → 该会话无上行帧(壳不伪造)。
 */
export interface BusFrameCapabilities {
  onBusFrame(cb: (frame: Record<string, unknown>) => void): () => void;
}

/**
 * 提问上行通道面:内核把「需要用户回答的提问」投给壳(壳落账 + 广播 + 投渲染层)。
 * 与契约的 `answerQuestion?`(下行:把答案送回内核)配成一对;两者可分别缺席。
 * 谁有:pi 有(`extension_ui` 帧翻译);dsh 走文件侧车桥(`DshQuestionBridge`,不经本面)。
 */
export interface QuestionChannelCapabilities {
  onQuestion(cb: (req: { requestId: string; questions: Question[] }) => void): () => void;
}

/**
 * 后端能力面集合(§7.6)——**按语义轴分面,能力名中性、不带内核名**。
 *
 * 为什么是一组小面而不是一个 opaque 桶:此前是 `extensions?: unknown`(形状定义在
 * `kernel/pi/backend/pi-backend-extensions.ts`,壳经 type-only import 收窄 + `as` 断言)。
 * 那个形状有三个实测后果:
 *   ① **application 跨界 import 内核内部**——检验⑪ allowlist 里唯一那条,「内核可整体卸载」打折;
 *   ② **一个桶被当多个轴的代理**:`session-store` 曾用 `capabilities.extensions != null` 当
 *      「有无文件头可写」的判据(该轴其实是 `fileBacked`),于是 minimal(`fileBacked: true`
 *      但无 pi 面)被误判——`minimal-backend.ts:52` 的注释正是为规避它而写的;
 *   ③ **降级粒度只有一个 bit**:`SessionCapabilities.extension` 让 renderer 一次性显隐
 *      steer/压缩/统计/队列/导出等全部功能,于是「dsh 缺多路并发」连带禁掉了它本可有的
 *      压缩与统计——违背「内核同等地位、同等功能」。
 * 分面之后每个轴可独立探测、独立降级,且新增一个轴不需要动既有轴(开闭原则)。
 *
 * 全部字段可选:无此面 = `undefined`,壳「有则用、无则降级」,不按内核身份硬分支。
 */
export interface BackendCapabilities {
  steering?: SteeringCapabilities;
  retry?: RetryCapabilities;
  compaction?: CompactionCapabilities;
  snapshot?: SnapshotCapabilities;
  stats?: StatsCapabilities;
  modelCycle?: ModelCycleCapabilities;
  toolExec?: ToolExecCapabilities;
  busFrames?: BusFrameCapabilities;
  questions?: QuestionChannelCapabilities;
  /** 思考档位面(懒探测缺面)。 */
  thinking?: ThinkingCapabilities;
  /** 会话是壳要跟踪的文件(`boundSessionPath` 指向会话文件):pi/minimal 声明 true,
   *  dsh 无(会话是 RPC 服务端 forest,壳不持文件)。「文件态」是**独立轴**,
   *  不许用任何能力面当它的代理(曾发生,见上 ②)。 */
  fileBacked?: boolean;
  /** 该内核是否承接**追加系统 prompt**(`BackendCreateOptions.systemPromptPaths` /
   *  `systemPromptTexts`)。
   *
   *  为什么需要这一轴(r50):这两个字段由 application 层**中性地**注入给每一个内核
   *  (`session-store.ts` 无内核分支),但实测只有一个内核的 backend-factory 消费它们,
   *  其余内核**静默忽略**——§1.5 唯一禁止的状态「静默缺面」(既不翻译、也不补面、也不降级)。
   *  而且这条路是**活的**:`systemPromptPaths` 来自 `registry.systemPromptPaths()`
   *  = 壳插件贡献的 `systemPrompts` 槽(`goody-hao` 插件正在用它),于是该插件在支持的
   *  内核下真注入、在其它内核下静默不生效,而用户从界面上看不出任何差别。
   *
   *  这一轴就是 §1.5 三条出路里的第三条(**显式降级**)的前提:先把不对称变成
   *  契约里可查询的事实,renderer 才能据此明示。取证与另两条出路见
   *  `docs/add-new-kernel.md` §4.2 的 r49 复核结论。
   *
   *  ⚠ 是**成员级**语义而非"面对象":系统 prompt 的注入发生在 spawn 期(工厂层),
   *  没有可在运行期调用的方法,所以用纯布尔(与 `fileBacked` 同范式),不造一个空对象面。 */
  systemPrompt?: boolean;
}

/**
 * 把入口级树投影成 lineage 树——§2.3「节点从条目换成分叉点」的纯函数实现。
 *
 * 一个 lineage = 沿首子(主干)走到尽头的最大线性链;某节点有 >1 个子节点即分叉点:
 * 首子延续当前 lineage,其余子各开一条分支 lineage,其 `fork.boundary` = 分叉点节点的 entryId。
 * 输入可能是森林(多个根):第一个根是 rootId,其余根各作一条独立根 lineage(fork = null)。
 *
 * 主干选择(首子)是当前约定;若内核以 `leafId` 定义主干(当前活跃叶子路径),调用方可在
 * 投影前先按 leafId 重排 children,把活跃分支放到首位。投影本身不感知 leafId。
 */
export function projectLineageTree(roots: TreeNode[]): LineageTree {
  const lineages: Lineage[] = [];
  const first = roots[0];
  const rootId = first?.entryId ?? "";

  const walk = (node: TreeNode, lineageId: string): void => {
    const children = node.children ?? [];
    if (children.length === 0) return;
    walk(children[0], lineageId);
    for (let i = 1; i < children.length; i++) {
      const child = children[i];
      const branchId = child.entryId;
      lineages.push({
        id: branchId,
        fork: { parentLineageId: lineageId, boundary: node.entryId },
      });
      walk(child, branchId);
    }
  };

  if (first) {
    lineages.push({ id: rootId, fork: null });
    walk(first, rootId);
  }
  for (let i = 1; i < roots.length; i++) {
    const root = roots[i];
    lineages.push({ id: root.entryId, fork: null });
    walk(root, root.entryId);
  }
  return { rootId, lineages };
}

/**
 * 中性:创建一个内核后端所需的全部入参。
 *
 * 不含任何内核专属 spawn 参数(args/env/cliPath/cordisConfig 等)——那些由各内核的工厂
 * 实现闭包捕获(bootstrap 组装时绑定)。契约只收「壳必须向每一个内核索要」的中性字段:
 * cwd(项目根)、kernel(路由依据)、provider/model(六条意图 setModel 的中性输入;
 * pi 走 setModel 命令、dsh 走 initialize 握手)、sessionId(打开/续接哪个会话)、
 * systemPromptPaths/Texts(注入什么提示)、ephemeral(临时会话)、maxTokens(输出上限)。
 *
 * **`agentDir` 已从契约删除**（勿加回）：它是"壳把内核的会话根告诉内核"这个假设的产物，
 * 而实情是**没有内核需要它**——三个内核都在自己的插件工厂里从 `KernelPluginContext`
 * （`homedir`/`dataRoot`）解析自己的数据根，spawn 时传进来的那个值一律被覆盖。
 * 一个"每个实现都忽略"的字段留在中立契约里有两个害处：① 读者以为壳管内核的数据根，
 * 而真相是内核自己管（§1.6 内核是被壳管理的外部资源，不是壳的子系统）；
 * ② 它会诱导新内核也去"接收"一个本该公司自己决定的东西。函数的实参是承诺，不兑现的承诺要删。
 */
export interface BackendCreateOptions {
  cwd: string;
  kernel: KernelId;
  /** 模型偏好(可选)。dsh 侧在 initialize 握手即用;pi 侧 spawn 后经 setModel 命令。 */
  provider?: string;
  model?: string;
  /** 中立会话主键(§kernel-forkless §12.2):壳只传 ns,内核私有会话 id 由各内核 adapter
   *  派生(pi=piDerivedSessionPath(agentDir,cwd,ns),dsh=ns)。 */
  neutralSessionId: string;
  /** 要物化的活跃 lineage id(§kernel-forkless §12.2):内核私有会话 id 派生自 **lineageId**
   *  而非 ns——root lineageId ≡ ns,分支 lineageId ≠ ns,fork 分支重 spawn 时必须按分支
   *  lineageId 派生自己的文件/session,否则分支回合写回根文件(根 lineageId 派生路径),
   *  文件对应漂移。缺省 = neutralSessionId(root lineage,幂等)。 */
  lineageId?: string;
  /** 要注入的 system prompt 文件路径(pi 翻译成 --append-system-prompt <path>;dsh 忽略)。 */
  systemPromptPaths?: string[];
  /** 内联 system prompt 文本(角色卡;pi 翻译成 --append-system-prompt <text>;dsh 忽略)。 */
  systemPromptTexts?: string[];
  /** 临时会话(测试/oneshot,不落正式会话):pi=--no-session,dsh=临时 DSH_SESSION_ROOT(stop 清理)。 */
  ephemeral?: boolean;
  /** 输出 token 上限(dsh initialize 握手用;pi 忽略)。 */
  maxTokens?: number;
}

/**
 * 后端工厂:中性契约,产出 BaseBackend。依赖倒置——application 只依赖本接口,
 * 实现归 client(各内核的 create*Backend),组装归 bootstrap(把接口和实现绑起来)。
 */
export interface BackendFactory {
  create(opts: BackendCreateOptions): BaseBackend;
  /**
   * 预 seed:在 spawn 之前产出目标内核的会话标识。生命周期不对称(§4.5):
   * - pi 的 seed 是纯文件写(不依赖进程),必须**先 seed 得路径、再以该路径 spawn**;
   * - dsh 的 seed 是 `session/seed` RPC(依赖进程),不能预 seed → 返回 null,由
   *   `create` 后的 `backend.seed` 在 `start` 之后处理。
   * 返回 null = 本内核不支持预 seed,调用方走"create → start → backend.seed"。
   */
  seed?(lineage: NeutralEntry[], opts: SeedOptions & { kernel: KernelId; cwd: string }): Promise<string | null>;
}

/**
 * 会话目录/CRUD 的中立面。与 BaseBackend 正交:BaseBackend 是 per-session 的进程+分支句柄
 * (有 start/stop 生命周期),本接口是 per-kernel 的跨会话存储(列/开/改/删/复制/统计)。
 * 壳不读任何内核的存储——这些操作的 pi 答案是 JSONL 文件 + parentId 树,dsh 答案是
 * append-only log + session forest,都退进各自适配器实现;壳只认中性类型(§7.5 不变量 #1)。
 */
export interface SessionCatalog {
  readonly kernel: KernelId;

  /** 重命名会话(名字真相源落存储)。 */
  rename(sessionId: string, name: string): Promise<void>;

  /** 改写会话元字段(pinned/archived/toolConfig/custom 域)。 */
  updateHeader(sessionId: string, patch: HeaderPatch): Promise<void>;

  /** 删除会话(真删,不可恢复)。 */
  deleteSessions(sessionIds: string[]): Promise<void>;

  /** 复制会话到目标(书签快照素材)。同步:pi 是 copyFileSync,forkFromSession 编排依赖
   *  「copy 在 setContext 之前的同步段」竞态护栏(见 forkFromSession);dsh 无此面,降级抛错。 */
  copy(srcId: string, dstId: string): void;

  /** 读会话工具配置(无配置返回 null)。 */
  readToolConfig(sessionId: string): Promise<SessionToolConfig | null>;

  /** 读会话头行的 desktop 私有数据(custom-my-harness-desktop;无字段/损坏返回 null)。 */
  readCustom(sessionId: string): Promise<Record<string, unknown> | null>;

  /** 读会话最近一次请求的实测 token 数(pi=context-probe 侧车;dsh 无此面返回 null)。
   *  同步:pi 是小文件 readFileSync;dsh 的 context usage 由原生暴露,不经此探针。 */
  contextProbeTokens(sessionId: string): number | null;

  /** 生成一个新会话的不透明 id。返回 string = 本内核需预生成会话标识(pi=新会话文件路径,
   *  先 seed/生成得 id 再 spawn);返回 null = 本内核惰性创建,无需预生成(dsh,服务端首次
   *  prompt 时惰性建会话)。同步:壳不自己拼内核的会话路径(§5 阶段 2 第 4 项)。 */
  newSessionId(cwd: string): string | null;

  /** 会话的投影地址(§kernel-forkless §12.2/§32):由 lineageId 确定性派生,幂等。
   *  pi=派生文件路径(piDerivedSessionPath),dsh=lineageId(SessionId 就是 lineageId)。
   *  作 SessionInfo.path(投影线索,不再做主键)。
   *  注意:投影地址是坐标系,不承诺磁盘上存在对应文件——「打开原始文件」必须走
   *  rawFilePath,不得把投影地址当文件路径直接打开。 */
  projectionPath(cwd: string, lineageId: string): string;

  /** 会话原始文件的真实磁盘路径(「打开原始文件」的唯一权威来源;§7.6 三分法:
   *  原始文件位置是内核专属知识,由本目录解析,壳/插件不拿投影地址硬猜)。
   *  pi=派生文件路径(存在才返回);dsh=<会话根>/<cwd 桶>/<lineageId>/session.jsonl.zstd
   *  (同样存在才返回)。返回 null = 磁盘上没有可打开的原始文件(临时会话/迁移前旧文件
   *  无投影等),调用方必须显式降级(提示用户),不得静默吞掉。 */
  rawFilePath(cwd: string, lineageId: string): string | null;

  /** 项目总统计:聚合本 cwd 桶下全部会话的 usage(含壳未运行期产生的会话)。 */
  projectStats(cwd: string): Promise<ProjectStats>;

  /** 读会话的 lineage 树(纯存储读,不需进程;pi=读 parentId 树,dsh=JSON-RPC)。 */
  getTree(sessionId: string): Promise<LineageTree>;

  /** 把分叉点持久化成可重启锚点(pi=拷贝快照到项目级目录,dsh=childSessionId)。
   *  同步:pi 是 copyFileSync;cwd 决定快照落点(项目级)。 */
  bookmark(cwd: string, lineageId: string, boundary: string): Anchor;

  /** 删除书签锚点(回收副本)。同步:pi 是 rmSync。 */
  deleteBookmark(anchor: Anchor): void;

  /**
   * 迟到的工具结果补写(ask 续问的续路面,docs/design/ask-design.md §5):
   * 把 toolResult 直接追加进内核会话存储——pi=会话 JSONL 追加 message 条目;
   * dsh=明文会话日志追加 tool/result 事件。仅在「提问发起进程已死」的续路调用
   * (活路由内核自己铸造);调用前调用方已停掉同槽位存活进程。
   * cwd 仅供需要按桶定位存储的内核(dsh)使用;pi 的 sessionId 即文件路径,忽略之。
   * 可缺面:内核无此写面则缺省不存在,壳显式降级(用户消息通道),不静默不伪造。
   */
  appendToolResult?(sessionId: string, toolCallId: string, outcome: ToolResultWriteback, cwd?: string): Promise<void>;
}

/** 补写的工具结果内容:正常答案(cancelled 缺省/false)或取消标记(cancelled=true → isError 落盘)。 */
export type ToolResultWriteback =
  | { answers: QuestionAnswer[]; cancelled?: false }
  | { cancelled: true };

/**
 * 目录/CRUD 工厂:产出某内核的 SessionCatalog。依赖倒置——application 只依赖本接口,
 * 实现归 client(各内核的 create*Catalog),组装归 bootstrap。
 */
export interface SessionCatalogFactory {
  create(kernel: KernelId): SessionCatalog;
}

/**
 * 内核模型源:一个内核的模型清单(已带 kernel 标)。pi=ModelsStore 的包装,dsh=DshConfigSource。
 * 圆心契约——application(model-catalog)依赖本接口,client 实现本接口(依赖倒置)。
 * 加第三个内核 = 加一个 KernelModelSource 实现,model-catalog 一行不改。
 */
export interface KernelModelSource {
  listModels(): ModelInfo[];
}
