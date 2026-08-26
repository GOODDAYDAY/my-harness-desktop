// web 服务化的线协议类型(web-service-architecture.md §6.1)。
// 纯类型、零依赖——不 import electron/react/ws。这是「对接契约」:用户服务端按此
// 消息形状对接,不加前缀、不改语义。channel 名沿用现有 IPC 常量树(§6.3)。
//
// 依赖只向内:本文件是圆心最外沿的「流入契约」,只被 core/application + api 引用,
// 不引用任何内层之外的实现。

import type { Host } from "./host";

/** C→S 请求。id 自增,跨连接唯一(wsTransport 内维护)。 */
export interface InvokeRequest {
  kind: "invoke";
  id: number;
  channel: string;
  args: unknown[];
}

/** S→C 应答。ok:false 时 error.message 为清晰提示,不裸透内核错误(§6.4)。 */
export interface ResultResponse {
  kind: "result";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message: string };
}

/** S→C 推送(原 webContents.send 的等价物)。 */
export interface PushMessage {
  kind: "push";
  channel: string;
  args: unknown[];
}

/** C→S 鉴权。token 是「local token」或「远程 HMAC token」(§8.3)。 */
export interface HelloRequest {
  kind: "hello";
  token: string;
}

/** S→C 鉴权结果。ok:false 后关闭连接(§6.4)。 */
export interface HelloResponse {
  kind: "hello";
  ok: boolean;
  error?: { code?: string; message: string };
}

/** 线协议消息联合(§6.1 五种)。 */
export type WireMessage =
  | InvokeRequest
  | ResultResponse
  | PushMessage
  | HelloRequest
  | HelloResponse;

/** 客户端身份(§8.3):local = 本机 Electron 窗口;remote = 外部浏览器。 */
export type ConnKind = "local" | "remote";

/** 每连接的上下文(§19.1)。host 是宿主能力面(§20),remote 连接为缺省降级实现。 */
export interface Conn {
  /** 连接唯一 id(ws-server 生成)。 */
  id: string;
  kind: ConnKind;
  host: Host;
  authenticated: boolean;
}

/** 网关健康/状态(§28.2,/status.json 的 body)。 */
export interface RemoteStatus {
  enabled: boolean;
  /** 监听地址(如 127.0.0.1:8420)。未启用时为空串。 */
  boundAddress: string;
  /** 已鉴权连接数。 */
  connections: number;
  /** 已注册 channel 数。 */
  channels: number;
}
