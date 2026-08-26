// 网关编排(web-service-architecture.md §19)——channel→handler 分发表 + 鉴权 + 广播扇出。
// 只依赖 domain(remote/host)+ 注入的 token 校验策略,不 import ws/http/electron(那是 api/http 的基础设施)。
//
// 依赖只向内:本层是「用例编排」(channel 分发、鉴权状态机、广播),传输(ws-server)在外层。
// 原 api/ipc/* 的 handler 逻辑搬到 api/http/handlers/*,只把 ipcMain.handle 换成 gateway.register。

import type { Conn, ConnKind, InvokeRequest, ResultResponse, WireMessage } from "../../domain/remote";

/** channel 绑定的 handler(§19.1)。conn 是首参(连接身份 + 宿主能力),...args 是位置参数。
 *  签名取 (conn, ...args) 而非 doc 的 (args, conn):与原 ipcMain.handle 的 (event, ...args)
 *  同形,搬迁时 handler 体零改动,只把 event 重解释为 conn(§16.2 Host 方法经 conn.host)。 */
export type Handler = (conn: Conn, ...args: any[]) => unknown | Promise<unknown>;

/** token 校验策略(§8.3/§19.2)。阶段 1 = 本地 token;阶段 3 = HMAC。返回身份,失败 null。 */
export type TokenVerifier = (token: string) => ConnKind | null;

export interface Gateway {
  /** 把 channel 绑到 handler(原 ipcMain.handle)。 */
  register(channel: string, handler: Handler): void;
  /** 校验 hello token,通过则标记 conn 身份 + 已鉴权(§19.2)。 */
  authenticate(conn: Conn, token: string): boolean;
  /** 分发一个 invoke(§32.2):鉴权 → 查表 → 执行 → 成/败应答。 */
  dispatch(conn: Conn, msg: InvokeRequest): Promise<ResultResponse>;
  /** 注册一个已鉴权连接的发送 sink(原 webContents.send 的等价收口)。返回取消函数。 */
  addSink(send: (msg: WireMessage) => void): () => void;
  /** 对每个已鉴权连接发 push(§19.4)。本地窗口与远程浏览器同路。 */
  broadcast(channel: string, ...args: unknown[]): void;
  /** 已注册 channel 数(/status.json)。 */
  channelCount(): number;
  /** 已鉴权连接数(/status.json)。 */
  connectionCount(): number;
}

/** 组装网关。verifyToken 由 bootstrap 注入(阶段 1 本地 token / 阶段 3 HMAC)。 */
export function createGateway(verifyToken: TokenVerifier): Gateway {
  const handlers = new Map<string, Handler>();
  const sinks = new Set<(msg: WireMessage) => void>();

  return {
    register(channel, handler) {
      handlers.set(channel, handler);
    },
    authenticate(conn, token) {
      const kind = verifyToken(token);
      if (!kind) return false;
      conn.kind = kind;
      conn.authenticated = true;
      return true;
    },
    async dispatch(conn, msg) {
      if (!conn.authenticated) {
        return { kind: "result", id: msg.id, ok: false, error: { code: "AUTH_REQUIRED", message: "未鉴权" } };
      }
      const handler = handlers.get(msg.channel);
      if (!handler) {
        return { kind: "result", id: msg.id, ok: false, error: { code: "UNKNOWN_CHANNEL", message: `未知 channel: ${msg.channel}` } };
      }
      try {
        const result = await handler(conn, ...msg.args);
        return { kind: "result", id: msg.id, ok: true, result };
      } catch (e) {
        return {
          kind: "result", id: msg.id, ok: false,
          error: { code: "HANDLER_ERROR", message: e instanceof Error ? e.message : String(e) },
        };
      }
    },
    addSink(send) {
      sinks.add(send);
      return () => { sinks.delete(send); };
    },
    broadcast(channel, ...args) {
      const msg: WireMessage = { kind: "push", channel, args };
      for (const send of sinks) send(msg);
    },
    channelCount() {
      return handlers.size;
    },
    connectionCount() {
      return sinks.size;
    },
  };
}
