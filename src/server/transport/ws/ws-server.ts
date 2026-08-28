// /rpc 的 WebSocket 服务(web-service-architecture.md §6.1/§7.3)——WS 升级 + 帧解析 → 网关。
// 基础设施层:本文件才 import ws(§7.2 网关不 import ws/http,这里收传输)。依赖只向内:
// 只 import domain 线协议 + application 网关/wire,不 import electron。
//
// 连接生命周期(§19.5):建立 → 鉴权(hello)→ 工作 → 断开回收。广播经 gateway.addSink 收口,
// 本地窗口与远程浏览器同路(§19.4)。
//
// 设备清单(第 23/24 项):连接注册表 + 踢单个/踢全部;增减与鉴权变化广播
// connectionsChanged,设置页设备列表事件驱动刷新(不轮询,§3.6)。

import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import type { Gateway, TokenVerifier } from "../../routing/gateway";
import type { Conn, ConnectionInfo } from "@my-harness-desktop/shared";
import type { Host } from "@my-harness-desktop/shared";
import { IPC, parseWire, serializeWire } from "@my-harness-desktop/shared";
import { SESSION_COOKIE, isLoopback, parseCookies } from "../../remote/net";

let connSeq = 0;

export interface WsServerOptions {
  /** loopback 信任边界(§8.3):本机浏览器直连免密 → local 身份。缺省 true;
   *  集成测试验证「未鉴权拒绝」语义时显式关闭。 */
  trustLoopback?: boolean;
}

/** 挂载后的操作面(第 19 项热重绑 + 第 23/24 项设备管理)。 */
export interface WsServerHandle {
  /** 终止全部 WS 客户端(升级后的 socket 不计入 server.close 等待,须显式清)。 */
  closeAllClients(): void;
  /** 已连接设备清单(不含 Host 大对象)。 */
  listConnections(): ConnectionInfo[];
  /** 踢单个连接(优雅关闭,客户端见断连横幅)。返回是否命中。 */
  kick(id: string): boolean;
  /** 踢全部连接。返回被踢数量。 */
  kickAll(): number;
}

/** 把 gateway 挂到 http server 的 /rpc 路径(§6.1)。host 是宿主能力面,verifyToken 是鉴权策略。 */
export function attachWsServer(server: Server, gateway: Gateway, host: Host, verifyToken: TokenVerifier, opts: WsServerOptions = {}): WsServerHandle {
  const trustLoopback = opts.trustLoopback ?? true;
  const wss = new WebSocketServer({ server, path: "/rpc" });
  // 连接注册表:id → 摘要 + socket。摘要即设备列表行,鉴权变化原地更新。
  const conns = new Map<string, { info: ConnectionInfo; ws: WebSocket }>();
  const notifyChanged = (): void =>
    gateway.broadcast(IPC.remote.connectionsChanged, [...conns.values()].map((c) => ({ ...c.info })));

  wss.on("connection", (ws, request) => {
    // 未鉴权连接:kind 缺省 remote,hello 或 cookie 后由 gateway.authenticate 定身份(§19.2)。
    const conn: Conn = {
      id: `conn-${++connSeq}`, kind: "remote", host, authenticated: false,
      remoteAddress: request.socket.remoteAddress,
      connectedAt: Math.floor(Date.now() / 1000),
    };
    // §8.2:浏览器登录后带 httpOnly cookie,WS 升级时先校验 cookie(mhd_session),命中即免 hello。
    const cookieToken = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (cookieToken) gateway.authenticate(conn, cookieToken);
    // 本机浏览器经 loopback 直连(§8.3):与本机窗口等价,信任边界即 loopback,免密码 →
    // local 身份。Electron 窗口另经 ?lt token 走 hello,两路在此汇合(同一身份)。
    if (!conn.authenticated && trustLoopback && isLoopback(request.socket.remoteAddress)) {
      conn.kind = "local";
      conn.authenticated = true;
    }
    conns.set(conn.id, {
      info: { id: conn.id, kind: conn.kind, authenticated: conn.authenticated, remoteAddress: conn.remoteAddress, connectedAt: conn.connectedAt },
      ws,
    });
    notifyChanged();
    const offSink = gateway.addSink((msg) => {
      if (ws.readyState === ws.OPEN) ws.send(serializeWire(msg));
    });

    ws.on("message", (data) => {
      let m;
      try {
        m = parseWire(String(data));
      } catch {
        return; // 坏帧忽略(§17.3 不炸连接)
      }
      if (m.kind === "hello" && "token" in m) {
        // C→S 的鉴权请求带 token;S→C 的 hello 应答带 ok(§6.1),此处只收前者。
        const ok = gateway.authenticate(conn, m.token);
        ws.send(serializeWire({ kind: "hello", ok }));
        if (!ok) { ws.close(); return; } // 鉴权失败关闭(§6.4)
        const entry = conns.get(conn.id);
        if (entry) { entry.info.authenticated = true; entry.info.kind = conn.kind; notifyChanged(); }
        return;
      }
      if (m.kind === "invoke") {
        void gateway.dispatch(conn, m).then((res) => {
          if (ws.readyState === ws.OPEN) ws.send(serializeWire(res));
        });
      }
    });

    ws.on("close", () => {
      offSink(); // 断开回收 sink(§19.5)
      if (conns.delete(conn.id)) notifyChanged();
    });
  });

  return {
    closeAllClients: () => { for (const c of wss.clients) c.terminate(); },
    listConnections: () => [...conns.values()].map((c) => ({ ...c.info })),
    kick: (id: string): boolean => {
      const entry = conns.get(id);
      if (!entry) return false;
      entry.ws.close(); // 优雅关闭:触发 close → 回收 + 广播
      return true;
    },
    kickAll: (): number => {
      let n = 0;
      for (const [, entry] of conns) { entry.ws.close(); n++; }
      return n;
    },
  };
}
