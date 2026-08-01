// 圆心:统一内核事件抽象 —— domain/events,零外部依赖。
//
// 依据 docs/core/event-mechanism.md §2。
// 一个 KernelEvent 联合覆盖四条信息流:
//   1. pi 底座事件(已翻译为中性 SessionEvent)
//   2. Extension UI 请求(底座→桌面端,需回复)
//   3. 进程退出/崩溃(桌面端自产)
//   4. RPC 错误(超时/进程退出导致 reject)
//
// SessionEvent 是底座事件的子集投影,KernelEvent 是全部信息流的投影。
// 插件订阅 onEvent 收「激活会话」的底座事件(视图流);订阅 onKernelEvent 收全量事件
// (含后台会话,带 sessionKey 归属)——运维类需求(列表刷新/统计)用后者,视图渲染用前者。

import type { SessionEvent } from "./session-state";

// ============ 来源一:pi 底座推送 ============

/** 底座事件(已翻译为中性 SessionEvent)。 */
export interface SessionMessageEvent {
  source: "pi";
  kind: "session";
  /** 事件来源会话(procs Map 的 key)——多会话并存时订阅方据此区分归属;
   *  对比 ProcessExit/RpcError 原有字段,此处补齐使四类事件归属信息一致。 */
  sessionKey: string;
  event: SessionEvent;
}

/** 底座 Extension UI 请求(需回复)。 */
export interface ExtensionUIRequestEvent {
  source: "pi";
  kind: "extensionUI";
  /** 请求 id(底座分配,回复时原样带回)。 */
  requestId: string;
  /** 请求来源会话(procs Map 的 key)。 */
  sessionKey: string;
  method: "select" | "confirm" | "input" | "editor" | "notify"
         | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  [key: string]: unknown;
}

// ============ 来源二:desktop 自产 ============

/** 进程退出(期望退出或崩溃)。 */
export interface ProcessExitEvent {
  source: "desktop";
  kind: "processExit";
  /** 退出码;null = 被 signal 杀死。 */
  code: number | null;
  /** 退出信号;null = 正常 exit。 */
  signal: string | null;
  /** 是否桌面端主动停止(期望退出,非崩溃)。 */
  expected: boolean;
  /** stderr 最后 500 字符(崩溃时辅助诊断)。 */
  stderr: string;
  /** 关联的会话 key(procs Map 的 key,非 sessionFile)。 */
  sessionKey: string;
}

/** RPC 命令失败(超时或进程退出导致 reject)。 */
export interface RpcErrorEvent {
  source: "desktop";
  kind: "rpcError";
  /** 失败原因分类。 */
  reason: "timeout" | "processExit" | "sendError";
  /** 超时时附带的命令 id(timeout 时有值)。 */
  requestId?: string;
  /** 错误消息。 */
  message: string;
  /** 关联的会话 key。 */
  sessionKey: string;
}

// ============ 统一联合 ============

/** 内核事件联合:覆盖底座推送 + 桌面端自产的全部信息流。 */
export type KernelEvent =
  | SessionMessageEvent
  | ExtensionUIRequestEvent
  | ProcessExitEvent
  | RpcErrorEvent;

// ============ Extension UI 回复类型 ============

/** Extension UI 回复(桌面端→底座,经 stdin 写回)。 */
export interface ExtensionUIResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}
