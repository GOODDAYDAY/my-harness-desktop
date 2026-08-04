// pi RPC 协议类型镜像 —— gateway/protocol,唯一可 import pi 类型处。
//
// 依据 pi SDK rpc-types.d.ts(0.82.x),re-declare 核心类型(不 import pi 包,保持自洽)。
// 31 个命令联合为 RpcCommand;响应/事件/状态/模型/条目/树/命令/Extension UI。
// 零外部依赖:只用 TS 内置类型。

/** ThinkingLevel(pi-agent-core)。 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

/** Model(pi-ai)。 */
export interface Model {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
}

/** ImageContent(pi-ai)。 */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** SessionEntry(pi session-manager)。 */
export interface SessionEntry {
  id: string;
  type: string;
  content?: unknown;
  toolCalls?: unknown[];
  toolCallId?: string;
  /** 线上真实形状是 ISO 字符串(底座 session-manager 全程 new Date().toISOString()),
   *  归一到 number 是投影层(context-binding)的职责,此处按线诚实声明。 */
  timestamp?: number | string;
}

/** SessionTreeNode(pi session-manager.getTree:{ entry, children, label, labelTimestamp })。 */
export interface SessionTreeNode {
  entry?: SessionEntry;
  children?: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

/** RpcSlashCommand。 */
export interface RpcSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: unknown;
}

/** RpcSessionState(get_state 返回)。 */
export interface RpcSessionState {
  model?: Model;
  thinkingLevel: ThinkingLevel;
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

/** 31 个 RPC 命令联合(按 type 区分)。 */
export type RpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string; images?: ImageContent[] }
  | { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "get_available_thinking_levels" }
  | { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" }
  | { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
  | { id?: string; type: "abort_bash" }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string; position?: "before" | "at" }
  | { id?: string; type: "clone" }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "get_entries"; since?: string }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "reload" };

/** RPC 响应(success + error 泛型)。 */
export type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: true;
  data?: unknown;
} | {
  id?: string;
  type: "response";
  command: string;
  success: false;
  error: string;
};

/** Extension UI 请求(底座→桌面端,需用户交互)。 */
export type RpcExtensionUIRequest = {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  [key: string]: unknown;
};

/** Extension UI 响应(桌面端→底座)。 */
export type RpcExtensionUIResponse = {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
};

/** AgentSessionEvent 联合类型(stdout 推的事件流,按 type 区分)。 */
export type AgentSessionEvent = {
  type: string;
  [key: string]: unknown;
};
