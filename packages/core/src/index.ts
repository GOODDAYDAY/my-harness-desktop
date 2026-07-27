// @pi-desktop/core —— 圆心契约类型的发布面(给插件 import 的包)。
//
// 依据 docs/plugins(20-guide-extension.md 等):插件只 import @pi-desktop/core
// 拿类型,不直接 import 项目内的 src/domain。
// 本包自洽定义契约类型(与 src/domain 字段一致,domain 是项目内圆心源、
// 本包是给插件的发布面;两份保持字段一致,演进时一并改)。
// 零运行时逻辑、零外部依赖(纯类型)。

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

/** 会话能力(默认注入,不需 permissions 声明——会话管理是核心)。 */
export interface SessionsApi {
  getSnapshot(): Promise<SyncSnapshot>;
  /** 强制重拉基线并广播(显式刷新用;常规读取走 getSnapshot 缓存)。 */
  sync(): Promise<SyncSnapshot>;
  onEvent(cb: (event: SessionEvent) => void): () => void;
  list(cwd: string): Promise<SessionInfo[]>;
  start(cwd: string): Promise<void>;
  newSession(): Promise<void>;
  switchSession(sessionPath: string): Promise<void>;
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
