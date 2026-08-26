// ws-server 集成测试(web-service-architecture.md §6/§19)——真实 ws server + client。
// 覆盖:hello 鉴权 → invoke 分发 → push 广播 → 未鉴权拒绝。

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createGateway } from "../../routing/gateway";
import { attachWsServer } from "./ws-server";
import type { Host } from "@my-harness-desktop/shared";

const hostStub = {} as Host;
const localToken: (t: string) => "local" | null = (t) => (t === "secret" ? "local" : null);

let servers: Server[] = [];

async function startServer(): Promise<{ url: string; gateway: ReturnType<typeof createGateway> }> {
  const gateway = createGateway(localToken);
  gateway.register("echo", (_conn, ...args) => args[0]);
  const server = createServer();
  attachWsServer(server, gateway, hostStub, localToken);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const addr = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${addr.port}/rpc`, gateway };
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));
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
});
