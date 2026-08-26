// /rpc 的 WebSocket 服务(web-service-architecture.md §6.1/§7.3)——WS 升级 + 帧解析 → 网关。
// 基础设施层:本文件才 import ws(§7.2 网关不 import ws/http,这里收传输)。依赖只向内:
// 只 import domain 线协议 + application 网关/wire,不 import electron。
//
// 连接生命周期(§19.5):建立 → 鉴权(hello)→ 工作 → 断开回收。广播经 gateway.addSink 收口,
// 本地窗口与远程浏览器同路(§19.4)。

import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { Gateway, TokenVerifier } from "../../application/remote/gateway";
import type { Conn } from "@my-harness-desktop/shared";
import type { Host } from "@my-harness-desktop/shared";
import { parseWire, serializeWire } from "@my-harness-desktop/shared";

/** 解析 Cookie 头 → { name: value }(§8.2)。 */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

let connSeq = 0;

/** 把 gateway 挂到 http server 的 /rpc 路径(§6.1)。host 是宿主能力面,verifyToken 是鉴权策略。 */
export function attachWsServer(server: Server, gateway: Gateway, host: Host, verifyToken: TokenVerifier): void {
  const wss = new WebSocketServer({ server, path: "/rpc" });

  wss.on("connection", (ws, request) => {
    // 未鉴权连接:kind 缺省 remote,hello 或 cookie 后由 gateway.authenticate 定身份(§19.2)。
    const conn: Conn = { id: `conn-${++connSeq}`, kind: "remote", host, authenticated: false };
    // §8.2:浏览器登录后带 httpOnly cookie,WS 升级时先校验 cookie(mhd_session),命中即免 hello。
    const cookieToken = parseCookies(request.headers.cookie)["mhd_session"];
    if (cookieToken) gateway.authenticate(conn, cookieToken);
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
        if (!ok) ws.close(); // 鉴权失败关闭(§6.4)
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
    });
  });
}
