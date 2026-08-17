// 圆心:会话能力契约 —— 核心(会话管理 + pi 交互)暴露给插件的 API 形状。
//
// 圆心只定义接口,实现在 application/sessions/session-store(依赖倒置)。
// 插件看到的是"会话意图"(prompt/abort/steer),不是 pi 协议命令字面量——
// 意图 → RpcCommand 的翻译在 application 层,圆心不感知 pi 协议。
//
// 接口继承层次:
//   RpcOps(基类:所有对底座 RPC 操作的共享契约)
//     ├─ MessagingApi(prompt/abort/steer/followUp/abortRetry)
//     ├─ ModelApi(getModels/setModel/cycleModel/getThinkingLevels/setThinkingLevel/cycleThinkingLevel)
//     ├─ SessionTreeApi(fork/clone/getForkMessages)
//     ├─ SessionMaintenanceApi(compact/exportHtml/getLastAssistantText/setAutoCompaction/setAutoRetry)
//     ├─ QueueModeApi(setSteeringMode/setFollowUpMode)
//     └─ BashApi(run/abortBash —— 需声明 rpc:bash 权限)
//
// SessionsApi(会话生命周期:start/stop/setContext/list/openSession/rename/updateHeader/onEvent/onSnapshot/getSnapshot/sync/getStats)
//   不继承 RpcOps —— 它管的是进程和文件,不是"发命令到底座"。
//
// 设计理由:所有对底座 RPC 操作共享同一个 send 通道、同一个 RpcAdapter、
// 同一个激活会话——这是继承关系,不是组合关系。
// 新底座命令加进来时,新建子接口 extends RpcOps,已有接口不改(开闭原则)。
import type { SessionEvent, SyncSnapshot, ModelInfo, NeutralMessage, SessionStats, ProjectStats } from "./events/session-state";
import type { KernelEvent } from "./events/kernel-event";
import type { LineageTree, Anchor } from "./backend";

/** 会话文件信息(扫描 ~/.pi/agent/sessions/<cwd桶>/ 得到)。 */
export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  /** 会话名(单轨存储:真相源=最后一条 session_info 条目;无条目时缺省,展示层经 deriveSessionTitle 回退) */
  name?: string;
  created: string;
  modified: string;
  /** 最后一条消息的前 30 字(副标题预览,超长截断带 …;无消息时缺省) */
  lastMessage?: string;
  /** 最后一条 entry 的 id(任何类型,不限消息;扫描派生,无 entry 时缺省)。
   *  展示层据此判定"读过之后是否有新内容":与私有已读位标比对,不等=有未读。 */
  lastEntryId?: string;
  /** 置顶(custom-pi-desktop.pinned 保留键的读出映射;展示层据此置顶组;缺省=false) */
  pinned?: boolean;
  /** 归档(custom-pi-desktop.archived 保留键的读出映射;归档的不进时间分组,收进底部"已归档"组;缺省=false) */
  archived?: boolean;
  /** 开放扩展命名空间(头行 custom-pi-desktop 字段的读出映射;desktop 私有、底座不感知)。
   *  desktop 私有数据统一存这里:保留键 pinned/archived/toolConfig 平铺顶层(desktop 核心属主,
   *  插件域不得占用),其余第一级 key 是域。约定(设计 docs/design/session-header-custom.md §2.4):
   *  1. 域 key 归属制——插件的域名即插件 id,desktop 模块按功能域命名;任何写入方不碰别人的域。
   *  2. 只放小元数据(id/路径/短串)——头行总长有 8KB 热读预算(readSessionHeader 与
   *     tool-gate 底座扩展同为 8KB 窗口),超限让 custom-pi-desktop 读取链静默失效。 */
  custom?: Record<string, unknown>;
}

/** 会话显示名的自动截断长度(按 code point 计)。
 *  自动命名/派生显示名唯一的截断长度源——改一处两侧跟随,杜絒两处各写一份数字漂移。 */
export const SESSION_NAME_DISPLAY_MAX = 20;

/** 会话名文本规范化:折叠连续空白→trim→按 code point 截断,超长补 "…"。
 *  "从文本派生会话名"的唯一截断实现:自动命名(session-store.prompt)与将来的
 *  派生显示名共用,杜绝两处各写一份 slice(0, N) 漂移。 */
export function truncateSessionName(text: string, max: number = SESSION_NAME_DISPLAY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max).join("").trimEnd()}…`;
}

/** 按 pi 底座编码规则算 cwd 桶目录名(--<cwd去首斜杠、斜杠换横线>--)。
 *  桶名规则的唯一源:application(session-scanner 文件扫描/新会话路径)与插件
 *  (session-bookmarks 收藏分桶)共用——规则是"会话按 cwd 分桶"的业务本质,
 *  纯字符串变换、零 IO,放圆心;改规则改这一处,杜绝各方手写替换链漂移。 */
export function cwdToBucketName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 提取中性消息 content 的纯文本:string 原样;内容块数组拼接所有 text 块;其余返回 ""。
 *  唯一实现——scanner 的 lastMessagePreview、session-store 的打开补命名、renderer 的
 *  消息去重此前各抄一份(textOfContent/textOf),收敛到圆心(契约单源 §1.3)。 */
export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
      .map((c) => String((c as Record<string, unknown>).text ?? ""))
      .join("");
  }
  return "";
}

/** 内容稳定哈希(djb2):桌面侧图片索引的匹配键——发送时与重开读回用同一文本算出同一 hash,
 *  图片展示独立于底座快照(桌面自己维护索引,不依赖底座内存)。 */
export function contentHashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/** 派生会话显示名(展示层唯一来源,§1.1 判别气味三——此前标题栏/图钉/重命名/列表行
 *  四个入口各写一套兜底:创建日期、null(显示"新会话")、id 前 8 位,同一会话三种显示):
 *  自定义名 → 消息预览(lastMessage,truncateSessionName 截断)→ id 前 8 位。
 *  不再用创建日期兜底——日期是"什么时候建的",不是"这个会话是什么"(根因见
 *  docs/design/session-name-tracks.md §6)。 */
export function deriveSessionTitle(session: { name?: string; lastMessage?: string; id: string }): string {
  const name = session.name?.trim();
  if (name) return name;
  const preview = session.lastMessage ? truncateSessionName(session.lastMessage) : "";
  return preview || session.id.slice(0, 8);
}

/** 打开历史会话的结果(纯文件读):文件头信息 + 全部时间线消息 + 文件聚合统计基线。 */
export interface SessionDetail {
  info: SessionInfo;
  messages: NeutralMessage[];
  /** 文件聚合的统计基线(message.usage 累加;contextUsage.tokens 取末条带 usage 的
   *  totalTokens——含 compaction 后重置,与底座口径一致;contextWindow 文件无,0 表未知;
   *  tps 文件无口径,null 诚实留空)。空会话(无消息)= null。
   *  与 messages 同数据源:打开即有,不依赖活进程;活会话 RPC 真值到达后覆盖。 */
  stats: SessionStats | null;
  /** 文件内的模型证据(model_change 条目 / assistant 消息的 provider+model,线性扫描末条
   *  胜出——与底座 getSessionContextSettings 同算法);无证据(空会话/旧格式)= undefined。
   *  编排层(openSession)据此查 models.json 把 contextWindow/percent 填进 stats.contextUsage,
   *  文件基线即带完整上下文占用——切会话不等 pi 预热也准确展示。 */
  modelEvidence?: { provider: string; modelId: string };
}

/** 图片输入(中性类型,对应底座 ImageContent)。 */
export interface ImageInput {
  data: string;
  mimeType: string;
  name?: string;
}

/** 会话级工具过滤配置。无 mode 字段(v7 起废弃):字段存在即过滤生效,
 *  enabledToolIds 显式空数组 = 全禁;无 session 配置时各组开关由 ToolGroup.defaultEnabled 决定。 */
export interface SessionToolConfig {
  enabledGroupIds?: string[];
  /** 组展开后的工具 id 清单(写侧 Apply 时解析落盘;消费方——timeline 软注入、
   *  tool-gate 底座扩展硬过滤——只认该字段,不回退组展开,不必各自再展开一遍)。 */
  enabledToolIds?: string[];
}

/** 会话角色卡 —— 会话级 system prompt(进程启动参数,非会话数据)。
 *  与全局 systemPrompts 槽同机制:spawn 时经 --append-system-prompt 注入——
 *  区别只在来源:全局槽是"所有会话共有的底",role 是"这个会话是谁";
 *  主会话与子会话平等,任何会话都可持有角色(编排器/主持人/玩家/执行器)。
 *  role 文本内联作 --append-system-prompt 的值(底座 resolvePromptInput 对非文件路径
 *  参数当文本本身),不落文件、不碰会话头行——system prompt 是进程参数,不是会话数据。 */
export interface SessionRole {
  /** 角色名(展示/文案用,如 "编排器"/"主持人";可选) */
  name?: string;
  /** 人设 —— 角色是谁、怎么思考、什么语气(核心,必填) */
  persona: string;
  /** 目标 —— 这个角色要达成什么(可选) */
  goal?: string;
  /** 行为约束 —— 必须遵守的规则(如"只能回答 是/否/无关")(可选) */
  constraints?: string;
  /** 背景知识 —— 只有这个角色知道的私密信息(如谜底/身份)(可选) */
  knowledge?: string;
}

/** 角色卡 → system prompt 文本(纯函数,零依赖)。只做结构化字段 → 可读文本的拼接,
 *  不含任何业务分支(圆心纪律)。spawn 时内联作 --append-system-prompt 的值注入——
 *  底座 resolvePromptInput 对非文件路径参数当作文本本身,无需落文件。 */
export function roleToPrompt(role: SessionRole): string {
  const lines: string[] = [`你是${role.name ?? "一个指定角色"}。`];
  if (role.persona) lines.push("", "## 人设", role.persona);
  if (role.goal) lines.push("", "## 目标", role.goal);
  if (role.constraints) lines.push("", "## 行为约束（必须遵守）", role.constraints);
  if (role.knowledge) lines.push("", "## 背景知识（只有你知道）", role.knowledge);
  return lines.join("\n");
}

/** tool-gate 播报的单个工具(中性形状,契约单源:写方 packages/toolgate、读方 client/pi、
 *  消费方 tool-manager 共用;sourceInfo 映射在扩展侧完成,此类型不见底座内部结构)。
 *  契约 docs/design/tool-manager-design.md §4.4.2。 */
export interface KnownToolInfo {
  name: string;
  description: string;
  source: "builtin" | "extension";
  extensionPath?: string;
}

/** 会话元字段补丁(与 updateHeader 契约一致)。desktop 私有数据统一落头行 custom-pi-desktop。 */
export type HeaderPatch = {
  /** 单轨写名字:只追加 session_info 条目(名字真相源),不写头行。空串/纯空白=显式清除。 */
  name?: string;
  /** 置顶,落 custom-pi-desktop.pinned 保留键;false=删键。 */
  pinned?: boolean;
  /** 归档,落 custom-pi-desktop.archived 保留键;false=删键。 */
  archived?: boolean;
  /** 工具过滤配置,落 custom-pi-desktop.toolConfig 保留键;null=删键。 */
  toolConfig?: SessionToolConfig | null;
  /** 头行 custom-pi-desktop 补丁:域级浅合并——{k:v} 只动 custom.k(域内整体替换,不深合并);
   *  {k:null} 删 k 域;null 清空整个命名空间(含保留键);删光后字段本身不留空壳。
   *  原子性由 updateSessionHeader 锁内读-改-写保证(设计 docs/design/session-header-custom.md §2.2)。 */
  custom?: Record<string, unknown> | null;
};

/** 会话级模型与思考深度(头行 custom-pi-desktop.model 域的形状)。
 *  设计 docs/design/session-model-config.md §3.2:单域三字段原子替换,没有混合态。 */
export interface SessionModelPrefs {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

/** custom-pi-desktop 里 model 域的 key(契约单源:写入方 session-store 与读取方共用)。 */
export const SESSION_MODEL_PREFS_KEY = "model";

/** 窄化读 model 域:三字段齐备且均为字符串才认,否则当不存在(读取链回落到下一级)。
 *  手改文件塞畸形数据不炸流程,该会话按"无自定义配置"处理(设计 §3.2 容错约定)。 */
export function parseSessionModelPrefs(custom: Record<string, unknown> | undefined): SessionModelPrefs | null {
  const v = custom?.[SESSION_MODEL_PREFS_KEY];
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.provider !== "string" || typeof o.modelId !== "string" || typeof o.thinkingLevel !== "string") return null;
  return { provider: o.provider, modelId: o.modelId, thinkingLevel: o.thinkingLevel };
}

/** Bash 执行结果。 */
export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ============ 基类接口:所有对底座 RPC 操作的共享契约 ============

/**
 * RpcOps —— 所有"发命令到底座"的操作的基类接口。
 * 子接口(MessagingApi/ModelApi/SessionTreeApi/...)继承此接口。
 * SessionStore 实现所有子接口,共享同一个 send 通道。
 */
export interface RpcOps {
  /** 会话统计(底座 get_session_stats):token 用量/上下文占用/消息计数/cost。
   *  TPS 由桌面端从 messageStart→messageEnd 事件流自算,底座不给。 */
  getStats(): Promise<SessionStats>;
}

/** 消息发送——继承 RpcOps。对激活会话发消息的各种变体。 */
export interface MessagingApi extends RpcOps {
  /** 发一条用户消息(唯一会起进程的入口)。resolve 只代表底座接受,输出靠事件流。 */
  prompt(text: string, images?: ImageInput[]): Promise<void>;
  /** 中断当前生成(底座 abort;pi 未启动时静默)。 */
  abort(): Promise<void>;
  /** 中途插入转向消息(steer 模式;settings.json steeringMode 控制排队行为)。 */
  steer(text: string, images?: ImageInput[]): Promise<void>;
  /** 排队消息(follow_up 模式;settings.json followUpMode 控制排队行为)。 */
  followUp(text: string, images?: ImageInput[]): Promise<void>;
  /** 中止正在进行的自动重试。 */
  abortRetry(): Promise<void>;
}

/** 模型连通性测试结果:ok 即通,不通带错误原因。 */
export interface ModelTestResult {
  ok: boolean;
  error?: string;
}

/** 模型与推理——继承 RpcOps。切换模型和思考强度。 */
export interface ModelApi extends RpcOps {
  /** 可选模型清单(底座 get_available_models)。 */
  getModels(): Promise<ModelInfo[]>;
  /** 切模型(底座 set_model)。 */
  setModel(provider: string, modelId: string): Promise<void>;
  /** 快捷循环切换模型(底座 cycle_model;走 --models 配置的列表)。 */
  cycleModel(): Promise<void>;
  /** 模型连通性测试:起独立临时会话进程发一条 ping,测完进程停、会话文件删,
   *  全程不触碰激活会话上下文。 */
  test(cwd: string, provider: string, modelId: string): Promise<ModelTestResult>;
  /** 可选思考强度清单(底座 get_available_thinking_levels)。 */
  getThinkingLevels(): Promise<string[]>;
  /** 切思考强度(底座 set_thinking_level)。 */
  setThinkingLevel(level: string): Promise<void>;
  /** 快捷循环切换思考强度(底座 cycle_thinking_level)。 */
  cycleThinkingLevel(): Promise<void>;
}

/** 会话树操作——继承 RpcOps。分叉、克隆、取分叉点消息。 */
export interface SessionTreeApi extends RpcOps {
  /** 回退重跑(§2.4.1 中性 fork):从指定 lineage 的 boundary 分叉出新 lineage。
   *  pi 后端 = 在 boundary 条目处 fork + 框架对账,返回分叉产物路径;position 语义收进后端(默认 at)。 */
  fork(parentLineageId: string, boundary?: string): Promise<string>;
  /** 克隆当前会话(底座 clone)。对账行为同 fork。 */
  clone(): Promise<void>;
  /** 从任意会话文件分叉(书签 fork 的原子用例):本质=开一个新会话(当前时间 header)
   *  + 预制内容(到 entryId 的分支)。框架编排:复制源文件到中间路径(注入的 agentDir、
   *  当前时间戳命名)→ start → fork → 删中间副本;失败回滚上下文并清理,不留孤儿文件。
   *  插件不碰会话目录布局——路径生成与清理全在框架内。 */
  forkFromSession(cwd: string, srcPath: string, entryId: string, position?: "before" | "at"): Promise<void>;
  /** 取分叉点的消息(底座 get_fork_messages)。 */
  getForkMessages(entryId: string): Promise<NeutralMessage[]>;
}

/** 会话维护——继承 RpcOps。压缩、导出、取最后一条 assistant 文本、自动重试开关。 */
export interface SessionMaintenanceApi extends RpcOps {
  /** 压缩上下文(底座 compact;可选自定义指令)。 */
  compact(customInstructions?: string): Promise<void>;
  /** 设置自动压缩开关(底座 set_auto_compaction)。 */
  setAutoCompaction(enabled: boolean): Promise<void>;
  /** 设置自动重试开关(底座 set_auto_retry)。 */
  setAutoRetry(enabled: boolean): Promise<void>;
  /** 导出会话为 HTML(底座 export_html;返回生成路径)。 */
  exportHtml(outputPath?: string): Promise<string>;
  /** 取最后一条 assistant 回复的纯文本(底座 get_last_assistant_text)。 */
  getLastAssistantText(): Promise<string>;
}

/** 队列模式——继承 RpcOps。控制 steer/follow_up 的排队行为。 */
export interface QueueModeApi extends RpcOps {
  /** 设置 steer 排队模式(底座 set_steering_mode)。 */
  setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
  /** 设置 follow_up 排队模式(底座 set_follow_up_mode)。 */
  setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
}

/** Bash 执行——继承 RpcOps。需声明 rpc:bash 权限。
 *  在底座进程上下文执行 bash 命令,等价 RCE,独立权限门控。 */
export interface BashApi extends RpcOps {
  /** 执行 bash 命令(底座 bash;excludeFromContext=true 不进会话上下文)。 */
  run(command: string, opts?: { excludeFromContext?: boolean }): Promise<BashResult>;
  /** 中止正在执行的 bash 命令(底座 abort_bash)。 */
  abortBash(): Promise<void>;
}

// ============ 会话生命周期接口(不继承 RpcOps)============

/**
 * 会话生命周期管理(默认注入,不需 permissions 声明)。
 * 进程模型:会话是文件,进程是按需的临时工——看会话走 openSession 纯文件读,
 * 只有 prompt 会起进程(ensureForSend:绑当前会话,绑错停旧起新,无 switch_session)。
 * 不继承 RpcOps:它管的是进程和文件,不是"发命令到底座"。
 */
export interface SessionsApi {
  /** 读投影基线(缓存;pi 未启动时 reject,调用方走 openSession 文件读)。 */
  getSnapshot(): Promise<SyncSnapshot>;
  /** 强制重拉基线并广播(显式刷新按钮用)。 */
  sync(): Promise<SyncSnapshot>;
  /** 订阅「激活会话」的中性事件流(视图流,驱动时间线渲染)。返回取消函数。
   *  多会话并存时后台会话的事件不进此流——运维类需求(列表刷新/统计)用 onKernelEvent。 */
  onEvent(cb: (event: SessionEvent) => void): () => void;
  /** 订阅全部内核事件(全量会话,带 sessionKey 归属:底座事件 + Extension UI + 进程退出 + RPC 错误)。 */
  onKernelEvent(cb: (event: KernelEvent) => void): () => void;
  /** 订阅底座 Extension UI 请求(需回复)。 */
  onExtensionUI(cb: (req: { requestId: string; method: string; [k: string]: unknown }) => void): () => void;
  /** 回复 Extension UI 请求。 */
  replyExtensionUI(requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: true }): Promise<void>;
  /** 订阅投影基线(start/switch/new 后每次推送一次)。 */
  onSnapshot(cb: (snapshot: SyncSnapshot) => void): () => void;
  /** 列某 cwd 桶下的历史会话文件。 */
  list(cwd: string): Promise<SessionInfo[]>;
  /** 打开历史会话:纯文件读头行信息+全部消息,不启 pi、零 RPC。文件不存在/损坏返回 null。 */
  openSession(sessionPath: string): Promise<SessionDetail | null>;
  /** 重命名会话(活跃走 RPC set_session_name;非活跃直接追加 session_info 条目;均落名字单轨;空名=清除)。 */
  renameSession(sessionPath: string, name: string): Promise<void>;
  /** 改写会话元字段;name 语义同 renameSession,pinned/archived/toolConfig 落 custom-pi-desktop 保留键。同一把锁,一处写头。 */
  updateHeader(sessionPath: string, patch: HeaderPatch): Promise<void>;
  /** 删除会话文件(真删 JSONL,不可恢复);批量=同目录一把锁内逐个删,不存在的跳过;活跃会话由实现侧跳过(删了也会被进程 append 复活)。 */
  deleteSessions(paths: string[]): Promise<void>;
  /** 记录发送路径上下文(cwd + 会话文件,null=新会话);只记,不动进程。 */
  setContext(cwd: string, sessionPath: string | null): void;
  /** 启动 pi(按需;sessionPath 给定时 spawn --session 续上下文;role 会话级角色卡注入系统上下文)。 */
  start(cwd: string, sessionPath?: string, role?: SessionRole): Promise<void>;
  /** 停 pi(壳内用)。 */
  stop(sessionPath?: string | null): Promise<void>;
  /** 复制会话文件(单个 JSONL)到目标路径。用于创建会话快照(收藏)。 */
  copySession(srcPath: string, targetPath: string): Promise<void>;
  /** 读会话工具配置(custom-pi-desktop.toolConfig 保留键;无配置返回 null)。 */
  readToolConfig(sessionPath: string): Promise<SessionToolConfig | null>;
  /** 项目总统计:聚合本 cwd 桶下全部会话 JSONL 的 message.usage(含 app 未运行期产生的会话)。
   *  纯文件读,不依赖活进程;实现侧按 mtime+size 增量缓存,重复调用廉价。 */
  projectStats(cwd: string): Promise<ProjectStats>;
  /** 底座 lineage 树(§2.4.2):拿一个会话的全部 lineage 及父子/分叉点关系。走 BaseBackend 中性操作。 */
  getTree(sessionId: string): Promise<LineageTree>;
  /** 底座 bookmark(§2.4.4):把一个分叉点持久化成可重启锚点。走 BaseBackend 中性操作。 */
  bookmark(lineageId: string, boundary: string): Promise<Anchor>;
  /** 底座 resume(§2.4.5):从一个锚点重启一条 lineage,返回重启后的 lineage id。 */
  resume(anchor: Anchor): Promise<string>;
  /** 删除一个书签锚点(回收后端自留副本)。 */
  deleteBookmark(anchor: Anchor): Promise<void>;
}

/** 项目目录 fs(permissions: "fs:project";读写均经 assertProjectPath 圈禁到项目根)。
 *  命名无 Read 前缀:removePath/createFile 等写操作同域,读写合一(docs/plugins/session-bookmarks.md §FsApi)。 */
export interface FsApi {
  listDir(cwd: string): Promise<{ name: string; isDir: boolean }[]>;
  removePath(path: string): Promise<void>;
  /** 读目录树:内核递归 walk,ignore 目录不回读内容。
   *  ignore/maxDepth 是内容(调用方定),不是内核常量——契约形状长期稳定,参数随调用方演进。 */
  readDirTree(cwd: string, opts?: ReadDirTreeOptions): Promise<FileTreeNode>;
  /** 读文本文件全文(限 1MB,超出抛错;二进制文件调用方自负)。 */
  readFile(path: string): Promise<string>;
  /** 读文件为 base64(限 25MB,超出抛错;图片/pdf 等二进制预览用,mime 由调用方按扩展名定)。 */
  readFileBase64(path: string): Promise<string>;
  /** 新建空文件;已存在抛错,父目录必须存在。 */
  createFile(path: string): Promise<void>;
  /** 新建单层目录;已存在抛错。 */
  createDir(path: string): Promise<void>;
  /** 重命名或移动(同目录=重命名,跨目录=移动);to 已存在抛错,from/to 双路径圈禁。 */
  renamePath(from: string, to: string): Promise<void>;
  /** 复制文件或目录(目录递归);to 已存在抛错,from/to 双路径圈禁。 */
  copyPath(from: string, to: string): Promise<void>;
}

/** 目录树节点(中性类型,不依赖任何运行时)。children 只有目录才有;
 *  目录的 children:undefined = 未下钻(限深边界/读失败,消费方可懒加载),空数组 = 空目录。 */
export interface FileTreeNode {
  name: string;
  isDir: boolean;
  children?: FileTreeNode[];
}

/** readDirTree 参数:可变性全部以参数形状承载,不写进契约形状。 */
export interface ReadDirTreeOptions {
  /** 递归限深,默认 3。 */
  maxDepth?: number;
  /** 忽略的目录名集合(node_modules/.git/dist 等),内核按名跳过,不回读其子树。 */
  ignore?: string[];
}

/** git 变更文件条目(双码:index=staged 区状态,worktree=工作区状态;未跟踪两码皆 "?")。 */
export interface GitChangedFile {
  path: string;
  index: string;
  worktree: string;
}

/** git status 汇总(分支名/ahead/behind 随状态一并返回,零额外调用)。 */
export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
}

/** git log 条目(commit 后确认落点用,只读)。 */
export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
}

/** git 工作区只读(permissions: "git:read")。 */
export interface GitReadApi {
  status(cwd: string): Promise<GitStatusResult>;
  fileDiff(cwd: string, path: string): Promise<string>;
  fileContent(cwd: string, path: string): Promise<string>;
  log(cwd: string, limit: number): Promise<GitLogEntry[]>;
}

/** git 工作区写操作(permissions: "git:write")。收敛面:只有 commit 和 push 两个口子。
 *  commit = add 指定文件 + commit(空 files 拒绝,无 --amend/--no-verify);
 *  push 仅当前分支到已配置 upstream(无 force、无 remote/branch 参数)。 */
export interface GitWriteApi {
  commit(cwd: string, message: string, files: string[]): Promise<{ ok: boolean; hash?: string; error?: string }>;
  push(cwd: string): Promise<{ ok: boolean; error?: string }>;
}

/** 一次性问底座(permissions: "llm:oneshot")。spawn `pi -p --no-session --no-tools`,
 *  不落会话、不带工具;prompt 由调用方(插件)拼装——内核只提供机制,不知道什么叫 commit message。 */
export interface LlmOneshotApi {
  oneshot(prompt: string): Promise<string>;
}

/** 系统对话框(默认注入:用户手势驱动,不泄露未选择的路径)。 */
export interface DialogApi {
openDirectory(): Promise<string | null>;
openImages(): Promise<{ name: string; data: string; mimeType: string }[]>;
/** 选一个文本文件并读回内容(用户手势驱动,默认放行)。内容由 main 读——renderer 的 fs
 *  能力圈禁项目根,够不到任意路径;返回 name+content,取消返回 null。超 1MB 抛错。 */
openTextFile(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; content: string } | null>;
  /** 保存文本文件(showSaveDialog;用户手势驱动)。写盘由 main 完成——renderer 的 fs
   *  圈禁项目根,够不到任意路径。返回保存路径,取消返回 null。 */
  saveTextFile(opts: { name: string; content: string; filters?: { name: string; extensions: string[] }[]; defaultFileName?: string }): Promise<string | null>;
  /** 写一组图片文件到用户选的目录(导出场景;目录经 openDirectory 用户手势选定,main 写盘)。
   *  返回写入数。图片名由调用方提供(含扩展名);重名覆盖。 */
  writeImages(dir: string, images: { name: string; base64: string }[]): Promise<number>;
  /** 打包文件为 zip 并保存(showSaveDialog;用户手势驱动)。files 是 {路径, base64} 清单,
   *  main 用 jszip 打包后写盘。返回保存路径,取消返回 null。 */
  saveZip(opts: { name: string; files: { name: string; base64: string }[]; defaultFileName?: string }): Promise<string | null>;
  /** 打开 zip 并解包(用户手势驱动)。返回 {name, files: {路径, base64}[]},取消返回 null。 */
  openZip(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; files: { name: string; base64: string }[] } | null>;
  /** 用系统默认应用打开文件(shell.openPath;~ 开头由 main 展开)。 */
  openFile(path: string): Promise<void>;
}

// ============ pi 底座模型配置契约(models.json 结构,圆心唯一源)============
//  提到圆心:pi-model-manager 插件经 @pi-desktop/contract 拿类型,不跨层 import application。
//  application/models/models-store 从此处 import 同一份(消除旧的双源)。

/** pi 底座 models.json 的单个模型配置。 */
export interface ModelConfig {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

/** pi 底座 models.json 的单个 provider 配置。 */
export interface ProviderConfig {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelConfig[];
}

/** pi 底座 models.json 结构(宽松,实际字段见底座 config.ts)。 */
export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}

/** models.json 声明序首个可用模型(第一个挂有模型的 provider 的首个 model);空配置返 null。
 *  消费方:sendMessage 新会话无默认模型时的发送兜底、timeline 显示链清单兜底——
 *  两处共用同一"首项"语义,契约单源,防两处各写一份展开逻辑漂移。 */
export function firstModelOf(cfg: ModelsConfig | null | undefined): { provider: string; modelId: string } | null {
for (const [provider, pc] of Object.entries(cfg?.providers ?? {})) {
const m = pc.models?.[0];
if (m) return { provider, modelId: m.id };
}
return null;
}

/** 导入合并报告:新增/合并计数,供 UI 预览"这次导入会动什么"(合并导入前的干跑结果)。 */
export interface ModelsMergeReport {
/** 导入方有、现有没有的 provider 数(整份新增)。 */
providersAdded: number;
/** 同 id 已存在、走字段级合并的 provider 数(无论字段是否真变——口径是"匹配并合并")。 */
providersMerged: number;
/** 同 provider 下按 id 新增挂上的 model 数(追加在该 provider 末尾)。 */
modelsAdded: number;
/** 同 provider 同 id、走字段级合并的 model 数。 */
modelsMerged: number;
}

/** models.json 导入合并(字段级深合并,非覆盖)。纯函数:入参不被改,返回全新树。
 *  - provider 同 id:标量字段浅合并(incoming 覆盖同名字段,未提供的保留),providersMerged++;
 *    不同 id:整份新增,providersAdded++,键序追加在末尾(base 声明序不动)。
 *  - models 按 id 合:同 id 字段浅合并({...base, ...incoming})、原位不动,modelsMerged++;
 *    新 id 追加在该 provider 末尾,modelsAdded++。
 *  消费方:pi-model-manager 导入弹窗——校验后干跑拿 report 预览,确认后 merged 走 onChange。 */
export function mergeModelsConfig(
base: ModelsConfig,
incoming: ModelsConfig,
): { merged: ModelsConfig; report: ModelsMergeReport } {
const report: ModelsMergeReport = { providersAdded: 0, providersMerged: 0, modelsAdded: 0, modelsMerged: 0 };
const providers: Record<string, ProviderConfig> = { ...base.providers };
for (const [id, inc] of Object.entries(incoming.providers ?? {})) {
const cur = providers[id];
if (!cur) {
providers[id] = inc;
report.providersAdded++;
continue;
}
report.providersMerged++;
const incModels = inc.models ?? [];
const curIds = new Set((cur.models ?? []).map((m) => m.id));
const models = (cur.models ?? []).map((m) => {
const patch = incModels.find((im) => im.id === m.id);
if (!patch) return m;
report.modelsMerged++;
return { ...m, ...patch };
});
for (const im of incModels) {
if (!curIds.has(im.id)) {
models.push(im);
report.modelsAdded++;
}
}
providers[id] = { ...cur, ...inc, models };
}
return { merged: { providers }, report };
}
