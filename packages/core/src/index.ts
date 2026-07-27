// @pi-desktop/core —— 圆心契约类型的发布面(给插件 import 的包)。
//
// 依据 docs/plugins(20-guide-extension.md 等):插件只 import @pi-desktop/core
// 拿类型,不直接 import 项目内的 src/domain。
// 本包自洽定义契约类型(与 src/domain 字段一致,domain 是项目内圆心源、
// 本包是给插件的发布面;两份保持字段一致,演进时一并改)。
// 纯类型 + 零依赖纯函数(sessionEntryToNeutral 是圆心的条目映射,无副作用、无 import)。

/** 主题:token key → 最终 CSS 值字符串的扁平映射(圆心消费的唯一主题数据结构)。 */
export type Theme = Record<string, string>;

/** 插件配置 API(DESIGN.md:760-764):get sync / set async / all sync。 */
export interface PluginConfigApi {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
  all(): Record<string, unknown>;
}

// ============ 会话能力(domain/sessions 镜像)============

/** 会话文件信息(扫描 ~/.pi/agent/sessions/<cwd桶>/ 得到)。 */
export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  /** 最后一条消息的前 30 字(副标题预览;无消息时缺省) */
  lastMessage?: string;
}

/** 图片输入(中性类型,对应底座 ImageContent)。 */
export interface ImageInput {
  data: string;
  mimeType: string;
  name?: string;
}

/** 中性模型信息。 */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** 中性会话状态。 */
export interface SessionState {
  model?: ModelInfo;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

/** 中性消息条目。 */
export interface MessageEntry {
  id: string;
  type: string;
  content?: unknown;
  toolCalls?: unknown[];
  toolCallId?: string;
  timestamp?: number;
}

/** 中性会话树节点。 */
export interface TreeNode {
  entryId: string;
  children?: TreeNode[];
  isLeaf?: boolean;
  label?: string;
}

/** 中性命令项。 */
export interface CommandItem {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

/** 中性对话消息(get_messages 的 AgentMessage:role + content,宽松透传)。 */
export interface NeutralMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

/** resync 一次拿到的全部同步数据(中性类型)。 */
export interface SyncSnapshot {
  state: SessionState;
  entries: MessageEntry[];
  /** 对话消息(get_messages,时间线数据源;entries 是会话树条目元数据,勿混用) */
  messages: NeutralMessage[];
  tree: TreeNode[];
  commands: CommandItem[];
  leafId: string | null;
}

/** 圆心中性事件(翻译后;宽松形状,插件按 type 挑感兴趣的收)。 */
export type SessionEvent = {
  type: string;
  [key: string]: unknown;
};

/**
 * pi 会话条目(JSONL 一行)→ 时间线 NeutralMessage(与 src/domain 双份契约,一并演进)。
 * 内容层(message/custom_message display=true)、分隔层(role="divider")、
 * 隐藏层(custom/label/display=false → null)。
 */
export function sessionEntryToNeutral(j: unknown): NeutralMessage | null {
  if (!j || typeof j !== "object") return null;
  const e = j as Record<string, unknown>;
  const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : undefined;

  if (e.type === "message" && e.message && typeof e.message === "object") {
    return { ...(e.message as Record<string, unknown>), timestamp: ts } as NeutralMessage;
  }
  if (e.type === "custom_message") {
    if (e.display === false) return null;
    return {
      role: typeof e.customType === "string" ? e.customType : "custom_message",
      content: typeof e.content === "string" ? e.content : "",
      timestamp: ts,
    } as NeutralMessage;
  }
  if (e.type === "model_change") {
    return divider(`模型 → ${e.provider}/${e.modelId}`, "model", ts);
  }
  if (e.type === "thinking_level_change") {
    return divider(`思考强度 → ${e.thinkingLevel}`, "thinking", ts);
  }
  if (e.type === "compaction") {
    const t = typeof e.tokensBefore === "number" ? fmtTokens(e.tokensBefore) : null;
    return divider(t ? `上下文已压缩(${t} tokens)` : "上下文已压缩", "compaction", ts,
      typeof e.summary === "string" ? e.summary : undefined);
  }
  if (e.type === "branch_summary") {
    return divider("分支摘要", "branch", ts, typeof e.summary === "string" ? e.summary : undefined);
  }
  if (e.type === "session_info") {
    return typeof e.name === "string" && e.name
      ? divider(`会话重命名为 "${e.name}"`, "info", ts)
      : null;
  }
  if (e.type === "label") {
    return divider(`书签: ${typeof e.label === "string" ? e.label : ""}`, "label", ts);
  }
  if (e.type === "custom" || e.type === "session") return null;
  return divider(String(e.type ?? "unknown"), "entry", ts, safeJson(j));
}

function divider(text: string, kind: string, timestamp?: number, detail?: string): NeutralMessage {
  return { role: "divider", kind, content: text, detail, timestamp } as NeutralMessage;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function safeJson(j: unknown): string {
  try {
    const s = JSON.stringify(j, null, 2);
    return s.length > 2000 ? s.slice(0, 2000) + "\n…(截断)" : s;
  } catch {
    return String(j);
  }
}

/** 会话能力(默认注入,不需 permissions 声明——会话管理是核心)。
 *  进程模型:会话是文件,进程是按需的临时工——openSession 纯文件读,
 *  只有 prompt 会起进程(绑当前会话,绑错停旧起新,无 switch_session)。 */
export interface SessionsApi {
  getSnapshot(): Promise<SyncSnapshot>;
  /** 强制重拉基线并广播(显式刷新用;常规读取走 getSnapshot 缓存)。 */
  sync(): Promise<SyncSnapshot>;
  onEvent(cb: (event: SessionEvent) => void): () => void;
  list(cwd: string): Promise<SessionInfo[]>;
  /** 打开历史会话:纯文件读全部消息,不启 pi、零 RPC。 */
  openSession(sessionPath: string): Promise<NeutralMessage[]>;
  /** 重命名会话(改写 JSONL 头行 name 字段)。 */
  renameSession(sessionPath: string, name: string): Promise<void>;
  /** 记录发送路径上下文(cwd + 会话文件,null=新会话);只记,不动进程。 */
  setContext(cwd: string, sessionPath: string | null): Promise<void> | void;
  /** 启动 pi(按需;sessionPath 给定时 spawn --session 续上下文)。 */
  start(cwd: string, sessionPath?: string): Promise<void>;
  stop(): Promise<void>;
  prompt(text: string, images?: ImageInput[]): Promise<void>;
  abort(): Promise<void>;
  getModels(): Promise<ModelInfo[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  getThinkingLevels(): Promise<string[]>;
  setThinkingLevel(level: string): Promise<void>;
}

/** 项目目录只读 fs(permissions: "fs:project")。 */
export interface FsReadApi {
  listDir(cwd: string): Promise<{ name: string; isDir: boolean }[]>;
}

/** git 工作区只读(permissions: "git:read")。 */
export interface GitReadApi {
  status(cwd: string): Promise<{ isRepo: boolean; files: { path: string; status: string }[] }>;
  fileDiff(cwd: string, path: string): Promise<string>;
  fileContent(cwd: string, path: string): Promise<string>;
}

/** 系统对话框(默认注入:用户手势驱动)。 */
export interface DialogApi {
  openDirectory(): Promise<string | null>;
  openImages(): Promise<{ name: string; data: string; mimeType: string }[]>;
  /** 用系统默认应用打开文件(shell.openPath;~ 开头由 main 展开)。 */
  openFile(path: string): Promise<void>;
}

/** 插件 PluginContext(圆心拥有;未声明权限的子对象调用时抛错,main 边界强制)。 */
export interface PluginContext {
  config: PluginConfigApi;
  sessions: SessionsApi;
  fs?: FsReadApi;
  git?: GitReadApi;
  dialog: DialogApi;
}

// ============ 槽位贡献项(domain/contributions 镜像)============

/** 主题槽贡献项(06 §4.1)。 */
export interface ThemeContribution {
  id: string;
  name: string;
  tokens: Record<string, string>;
  base?: string;
}

/** 设置子页槽(settings)贡献项(DESIGN.md §3.3)。 */
export interface SettingsContribution {
  id: string;
  title: string;
  component: string;
  /** 配置文件路径(~ 开头,框架展开)。null=无配置文件(不显示打开按钮)。 */
  configFile?: string | null;
  /** 写入合并方式:"deep"=深合并,"replace"=整份覆盖。默认 "replace"。 */
  configMerge?: "deep" | "replace";
  /** 保存模式:"framework"=框架管 save/reset/dirty(有浮层/拦截),"manual"=实时生效(无浮层/拦截,仅显示打开按钮)。默认 "framework"。 */
  saveMode?: "framework" | "manual";
}

/** 侧栏槽(sidePanel)贡献项:右侧板的 Tab(DESIGN.md:939 {id,label,icon,component})。 */
export interface SidePanelContribution {
  id: string;
  label: string;
  icon: string;
  component: string;
}

/** 左栏分组槽(sidebar)贡献项 —— 八槽之外的扩展槽(本轮新开)。 */
export interface SidebarContribution {
  id: string;
  title: string;
  component: string;
  order?: number;
}

/** SlotName:槽名(DESIGN.md §3.3 八槽 + 扩展槽 sidebar)。 */
export type SlotName =
  | "languages"
  | "themes"
  | "management"
  | "cardRenderers"
  | "sidePanel"
  | "sidebar"
  | "viewers"
  | "commands"
  | "settings";

/** 插件 manifest 顶层 contributes 字段。 */
export interface PluginContributes {
  themes?: ThemeContribution[];
  settings?: SettingsContribution[];
  sidePanel?: SidePanelContribution[];
  sidebar?: SidebarContribution[];
}

/** 插件 manifest(04-module §2.2)。 */
export interface PluginManifest {
  id: string;
  version: string;
  displayName?: string;
  main?: string;
  renderer?: string;
  permissions?: string[];
  contributes?: PluginContributes;
  author?: string;
  homepage?: string;
  dependsOn?: string[];
  source?: "project" | "user" | "installed" | "builtin";
}
