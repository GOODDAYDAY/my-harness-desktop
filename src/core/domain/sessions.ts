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

/** 会话文件信息(扫描 ~/.pi/agent/sessions/<cwd桶>/ 得到)。 */
export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  /** 会话名(真相源=最后一条 session_info 条目,头行 header.name 仅历史兜底;都没有时展示层回退 id) */
  name?: string;
  created: string;
  modified: string;
  /** 最后一条消息的前 30 字(副标题预览,超长截断加 …;无消息时缺省) */
  lastMessage?: string;
  /** 最后一条 entry 的 id(任何类型,不限消息;扫描派生,无 entry 时缺省)。
   *  展示层据此判定"读过之后是否有新内容":与私有已读位标比对,不等=有未读。 */
  lastEntryId?: string;
  /** 置顶(header.pinned;展示层据此置顶组;缺省=false) */
  pinned?: boolean;
  /** 归档(header.archived;归档的不进时间分组,收进底部"已归档"组;缺省=false) */
  archived?: boolean;
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

/** 打开历史会话的结果(纯文件读):文件头信息 + 全部时间线消息。 */
export interface SessionDetail {
  info: SessionInfo;
  messages: NeutralMessage[];
}

/** 图片输入(中性类型,对应底座 ImageContent)。 */
export interface ImageInput {
  data: string;
  mimeType: string;
  name?: string;
}

/** 会话级工具过滤配置。 */
export interface SessionToolConfig {
  mode: "all" | "custom";
  enabledGroupIds?: string[];
  /** 组展开后的工具 id 清单(写侧 Apply 时解析落盘;非空则优先于 enabledGroupIds,
   *  消费方——timeline 软注入、tool-gate 底座扩展硬过滤——不必各自再展开一遍)。 */
  enabledToolIds?: string[];
}

/** 头行可选字段补丁(与 updateHeader 契约一致)。 */
export type HeaderPatch = { name?: string; pinned?: boolean; archived?: boolean; toolConfig?: SessionToolConfig | null };

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
  /** 从指定条目分叉出新会话(底座 fork)。 */
  fork(entryId: string): Promise<void>;
  /** 克隆当前会话(底座 clone)。 */
  clone(): Promise<void>;
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
  /** 重命名会话(活跃走 RPC set_session_name 落 session_info;非活跃写头行 + 追加 session_info;空名=清除)。 */
  renameSession(sessionPath: string, name: string): Promise<void>;
  /** 改写会话元字段;name 语义同 renameSession,pinned/archived/toolConfig 是头行私有字段。同一把锁,一处写头。 */
  updateHeader(sessionPath: string, patch: HeaderPatch): Promise<void>;
  /** 删除会话文件(真删 JSONL,不可恢复);批量=同目录一把锁内逐个删,不存在的跳过;活跃会话由实现侧跳过(删了也会被进程 append 复活)。 */
  deleteSessions(paths: string[]): Promise<void>;
  /** 记录发送路径上下文(cwd + 会话文件,null=新会话);只记,不动进程。 */
  setContext(cwd: string, sessionPath: string | null): void;
  /** 启动 pi(按需;sessionPath 给定时 spawn --session 续上下文)。 */
  start(cwd: string, sessionPath?: string): Promise<void>;
  /** 停 pi(壳内用)。 */
  stop(sessionPath?: string | null): Promise<void>;
  /** 复制会话文件(单个 JSONL)到目标路径。用于创建会话快照(收藏)。 */
  copySession(srcPath: string, targetPath: string): Promise<void>;
  /** 读会话工具配置(头行 toolConfig 字段;无配置返回 null)。 */
  readToolConfig(sessionPath: string): Promise<SessionToolConfig | null>;
  /** 最近会话的模型/思考强度设置。 */
  recentSettings(cwd: string): Promise<{ provider?: string; modelId?: string; thinkingLevel?: string }>;
  /** 项目总统计:聚合本 cwd 桶下全部会话 JSONL 的 message.usage(含 app 未运行期产生的会话)。
   *  纯文件读,不依赖活进程;实现侧按 mtime+size 增量缓存,重复调用廉价。 */
  projectStats(cwd: string): Promise<ProjectStats>;
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
  /** 新建空文件;已存在抛错,父目录必须存在。 */
  createFile(path: string): Promise<void>;
  /** 新建单层目录;已存在抛错。 */
  createDir(path: string): Promise<void>;
  /** 重命名或移动(同目录=重命名,跨目录=移动);to 已存在抛错,from/to 双路径圈禁。 */
  renamePath(from: string, to: string): Promise<void>;
  /** 复制文件或目录(目录递归);to 已存在抛错,from/to 双路径圈禁。 */
  copyPath(from: string, to: string): Promise<void>;
}

/** 目录树节点(中性类型,不依赖任何运行时)。children 只有目录才有。 */
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

/** git 工作区只读(permissions: "git:read")。 */
export interface GitReadApi {
  status(cwd: string): Promise<{ isRepo: boolean; files: { path: string; status: string }[] }>;
  fileDiff(cwd: string, path: string): Promise<string>;
  fileContent(cwd: string, path: string): Promise<string>;
}

/** 系统对话框(默认注入:用户手势驱动,不泄露未选择的路径)。 */
export interface DialogApi {
  openDirectory(): Promise<string | null>;
  openImages(): Promise<{ name: string; data: string; mimeType: string }[]>;
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
