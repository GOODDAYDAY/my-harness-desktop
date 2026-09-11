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

/** 等到**满足条件**的那条消息 —— 期间可能插入无关推送(实测:连接鉴权成功后服务端还会推一条
 *  `remote:connectionsChanged`)。一次性 `nextMessage` 会取到无关那条,断言随即失败——
 *  这是**偶发**(取决于两条推送的到达次序),本文件第 3 行的稳定性注记记的就是它。
 *  只等"我要的那条",与到达次序无关。 */
/** "是一条回复,不是无关推送"。插队的**永远是 push**(实测:`remote:connectionsChanged`),
 *  所以"等下一条非 push 消息"对本文件所有"等具体回复"的断言都成立,且与到达次序无关。 */
const isReply = (m: any): boolean => m.kind !== "push";

function nextMessageWhere(ws: WebSocket, pred: (m: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off("message", onMsg);
      ws.off("close", onClose);
    };
    const onMsg = (d: unknown): void => {
      const m = JSON.parse(String(d));
      if (!pred(m)) return;                       // 无关推送:继续等,不当作结果
      cleanup();
      resolve(m);
    };
    const onClose = (): void => { cleanup(); reject(new Error("ws closed before matching message")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("nextMessageWhere timeout(5s)")); }, WAIT_CAP);
    ws.on("message", onMsg);
    ws.on("close", onClose);
  });
}

describe("ws-server", () => {
  it("hello 鉴权通过 → invoke echo 返回 ok 结果", async () => {
    const { url } = await startServer();
    const ws = await connect(url);
    ws.send(JSON.stringify({ kind: "hello", token: "secret" }));
    await expect(nextMessageWhere(ws, isReply)).resolves.toEqual({ kind: "hello", ok: true });
    ws.send(JSON.stringify({ kind: "invoke", id: 1, channel: "echo", args: ["hi"] }));
    await expect(nextMessageWhere(ws, isReply)).resolves.toEqual({ kind: "result", id: 1, ok: true, result: "hi" });
    ws.close();
  });

  it("未鉴权 invoke → AUTH_REQUIRED 结果(不关连接,由 hello 流程决定)", async () => {
    const { url } = await startServer();
    const ws = await connect(url);
    ws.send(JSON.stringify({ kind: "invoke", id: 2, channel: "echo", args: ["x"] }));
    const res = await nextMessageWhere(ws, isReply);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("AUTH_REQUIRED");
    ws.close();
  });

  it("hello 失败 → ok:false 后关闭", async () => {
    const { url } = await startServer();
    const ws = await connect(url);
    ws.send(JSON.stringify({ kind: "hello", token: "wrong" }));
    await expect(nextMessageWhere(ws, isReply)).resolves.toEqual({ kind: "hello", ok: false });
    ws.close();
  });

  it("广播 push 扇出到已鉴权连接", async () => {
    const { url, gateway } = await startServer();
    const ws = await connect(url);
    ws.send(JSON.stringify({ kind: "hello", token: "secret" }));
    await nextMessageWhere(ws, isReply);
    gateway.broadcast("session:event", { type: "x" });
    // 等**我要的那条**:鉴权成功后服务端还会推 remote:connectionsChanged,
    // 用一次性 nextMessage 会偶发取到它(见 nextMessageWhere 注释)。
    await expect(nextMessageWhere(ws, (m) => m.channel === "session:event"))
      .resolves.toEqual({ kind: "push", channel: "session:event", args: [{ type: "x" }] });
    ws.close();
  });

  it("loopback 信任(§8.3):本机直连免 hello,身份 local", async () => {
    const { url } = await startServer({ trustLoopback: true });
    const ws = await connect(url); // 不发 hello,直接 invoke
    ws.send(JSON.stringify({ kind: "invoke", id: 3, channel: "whoami", args: [] }));
    await expect(nextMessageWhere(ws, isReply)).resolves.toEqual({ kind: "result", id: 3, ok: true, result: "local" });
    ws.close();
  });
});
