// ws-server 集成测试(web-service-architecture.md §6/§19)——真实 ws server + client。
// 覆盖:hello 鉴权 → invoke 分发 → push 广播 → 未鉴权拒绝。
// 稳定性(套件并发实测 r355):connect/nextMessage 在高并发 worker 下偶发事件循环
// 饿死(open/message 永不到达 → 挂到 20s 超时,套件 ~1/8 轮闪红)。修法:所有等待
// 带 5s 上限 + connect 失败一次即重试(瞬态饿死的简单恢复),失败信息带上下文。

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createGateway } from "../../routing/gateway";
import { attachWsServer } from "./ws-server";
import type { Host } from "@my-harness-desktop/shared";

const hostStub = {} as Host;
const localToken: (t: string) => "local" | null = (t) => (t === "secret" ? "local" : null);
/** 等待上限:正常路径毫秒级;5s 只在并发饿死时兜底(远小于 20s 测试超时)。 */
const WAIT_CAP = 5_000;

let servers: Server[] = [];
let closers: Array<() => void> = [];

async function startServer(opts?: { trustLoopback?: boolean }): Promise<{ url: string; gateway: ReturnType<typeof createGateway> }> {
  const gateway = createGateway(localToken);
  gateway.register("echo", (_conn, ...args) => args[0]);
  gateway.register("whoami", (conn) => conn.kind);
  const server = createServer();
  // 存量用例验证「未鉴权拒绝」语义,显式关 loopback 信任;生产缺省开。
  const handles = attachWsServer(server, gateway, hostStub, localToken, { trustLoopback: false, ...opts });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  closers.push(handles.closeAllClients);
  const addr = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${addr.port}/rpc`, gateway };
}

afterEach(async () => {
  // 先硬断全部客户端连接(terminate 免四步挥手等待),再关 http server——
  // 否则并发 worker 下 server.close() 等活跃连接排空会拖过 hook 超时,
  // 且残留连接还会吃到下个用例的广播(r355 实钉闪红根因)。
  for (const c of closers) { try { c(); } catch { /* 已关 */ } }
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  closers = [];
}, 10_000);

/** 连接(带 5s 上限 + 一次重试:并发饿死时 open 事件可能瞬态不到,重试即恢复)。 */
async function connect(url: string, attempt = 0): Promise<WebSocket> {
  try {
    return await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`connect timeout (attempt ${attempt}) ${url}`));
      }, WAIT_CAP);
      ws.on("open", () => { clearTimeout(timer); resolve(ws); });
      ws.on("error", (e) => { clearTimeout(timer); ws.terminate(); reject(e); });
    });
  } catch (e) {
    if (attempt < 1) return connect(url, attempt + 1);
    throw e;
  }
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("nextMessage timeout(5s)")), WAIT_CAP);
    ws.once("message", (d) => { clearTimeout(timer); resolve(JSON.parse(String(d))); });
    ws.once("close", () => { clearTimeout(timer); reject(new Error("ws closed before message")); });
  });
}

describe("ws-server", () => {
  it("hello 鉴权通过 → invoke echo 返回 ok 结果", async () => {
    const { url } = await startServer();
    const ws = await connect(url);
    ws.send(JSON.stringify({ kind: "hello", token: "secret" }));
    await expect(nextMessage(ws)).resolves.toEqual({ kind: "hello", ok: true });
    ws.send(JSON.stringify({ kind: "invoke", id: 1, channel: "echo", args: ["hi"] }));
    await expect(nextMessage(ws)).resolves.toEqual({ kind: "result", id: 1, ok: true, result: "hi" });
    ws.close();
  });

  it("未鉴权 invoke → AUTH_REQUIRED 结果(不关连接,由 hello 流程决定)", async () => {
    const { url } = await startServer();
    const ws = await connect(url);
    ws.send(JSON.stringify({ kind: "invoke", id: 2, channel: "echo", args: ["x"] }));
    const res = await nextMessage(ws);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("AUTH_REQUIRED");
    ws.close();
  });

  it("hello 失败 → ok:false 后关闭", async () => {
    const { url } = await startServer();
    const ws = await connect(url);
    ws.send(JSON.stringify({ kind: "hello", token: "wrong" }));
    await expect(nextMessage(ws)).resolves.toEqual({ kind: "hello", ok: false });
    ws.close();
  });

  it("广播 push 扇出到已鉴权连接", async () => {
    const { url, gateway } = await startServer();
    const ws = await connect(url);
    ws.send(JSON.stringify({ kind: "hello", token: "secret" }));
    await nextMessage(ws);
    gateway.broadcast("session:event", { type: "x" });
    await expect(nextMessage(ws)).resolves.toEqual({ kind: "push", channel: "session:event", args: [{ type: "x" }] });
    ws.close();
  });

  it("loopback 信任(§8.3):本机直连免 hello,身份 local", async () => {
    const { url } = await startServer({ trustLoopback: true });
    const ws = await connect(url); // 不发 hello,直接 invoke
    ws.send(JSON.stringify({ kind: "invoke", id: 3, channel: "whoami", args: [] }));
    await expect(nextMessage(ws)).resolves.toEqual({ kind: "result", id: 3, ok: true, result: "local" });
    ws.close();
  });
});
