// 圆心:会话能力契约 —— 核心(会话管理 + pi 交互)暴露给插件的 API 形状。
//
// 圆心只定义接口,实现在 application/sessions/session-store(依赖倒置)。
// 插件看到的是"会话意图"(prompt/abort/newSession),不是 pi 协议命令字面量——
// 意图 → RpcCommand 的翻译在 application 层,圆心不感知 pi 协议。
import type { SessionEvent, SyncSnapshot, ModelInfo, NeutralMessage } from "./events/session-state";

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

/** 会话能力(默认注入,不需 permissions 声明——会话管理是核心,任何插件可用)。
 *  进程模型:会话是文件,进程是按需的临时工——看会话走 openSession 纯文件读,
 *  只有 prompt 会起进程(ensureForSend:绑当前会话,绑错停旧起新,无 switch_session)。 */
export interface SessionsApi {
  /** 读投影基线(缓存;pi 未启动时 reject,调用方走 openSession 文件读)。 */
  getSnapshot(): Promise<SyncSnapshot>;
  /** 强制重拉基线并广播(显式刷新按钮用)。 */
  sync(): Promise<SyncSnapshot>;
  /** 订阅中性事件流(SessionEvent,非 pi 原始事件)。返回取消函数。 */
  onEvent(cb: (event: SessionEvent) => void): () => void;
  /** 列某 cwd 桶下的历史会话文件。 */
  list(cwd: string): Promise<SessionInfo[]>;
  /** 打开历史会话:纯文件读全部消息,不启 pi、零 RPC。 */
  openSession(sessionPath: string): Promise<NeutralMessage[]>;
  /** 记录发送路径上下文(cwd + 会话文件,null=新会话);只记,不动进程。 */
  setContext(cwd: string, sessionPath: string | null): void;
  /** 启动 pi(按需;sessionPath 给定时 spawn --session 续上下文)。 */
  start(cwd: string, sessionPath?: string): Promise<void>;
  /** 停 pi(壳内用)。 */
  stop(): Promise<void>;
  /** 发一条用户消息(唯一会起进程的入口)。resolve 只代表底座接受,输出靠事件流。 */
  prompt(text: string, images?: ImageInput[]): Promise<void>;
  /** 中断当前生成(底座 abort;pi 未启动时静默)。 */
  abort(): Promise<void>;
  /** 可选模型清单(底座 get_available_models)。 */
  getModels(): Promise<ModelInfo[]>;
  /** 切模型(底座 set_model)。 */
  setModel(provider: string, modelId: string): Promise<void>;
  /** 可选思考强度清单(底座 get_available_thinking_levels)。 */
  getThinkingLevels(): Promise<string[]>;
  /** 切思考强度(底座 set_thinking_level)。 */
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

/** 系统对话框(默认注入:用户手势驱动,不泄露未选择的路径)。 */
export interface DialogApi {
  openDirectory(): Promise<string | null>;
  openImages(): Promise<{ name: string; data: string; mimeType: string }[]>;
  /** 用系统默认应用打开文件(shell.openPath;~ 开头由 main 展开)。 */
  openFile(path: string): Promise<void>;
}
