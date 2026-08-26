// JsonRpcTransport 单测:request 带 id 配对、notification 分发、error 响应 reject。
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { SubprocessHandle } from "../../pi/backend/subprocess-handle";
import { JsonRpcTransport, DshRpcError } from "./json-rpc";

/** 记录写入的假 stdin。 */
class FakeStdin {
  writes: string[] = [];
  write(s: string): boolean {
    this.writes.push(s);
    return true;
  }
}

/** 假 SubprocessHandle:stdout 用 PassThrough 可推帧,stdin 记录写入。 */
function fakeHandle(): { handle: SubprocessHandle; stdout: PassThrough; stdin: FakeStdin } {
  const stdout = new PassThrough();
  const stdin = new FakeStdin();
  const handle = {
    stdin,
    stdout,
    alive: true,
    stop: async () => {},
    onceExit: () => {},
    onceError: () => {},
    onStderr: () => {},
  } as unknown as SubprocessHandle;
  return { handle, stdout, stdin };
}

describe("JsonRpcTransport", () => {
  it("request 写 JSON-RPC 帧并按 id 配对 resolve", async () => {
    const { handle, stdout, stdin } = fakeHandle();
    const t = new JsonRpcTransport(handle);
    t.start();
    const p = t.request<{ ok: true }>("initialize", { cwd: "/x", provider: "p", model: "m" });
    expect(stdin.writes).toHaveLength(1);
    const frame = JSON.parse(stdin.writes[0]);
    expect(frame).toMatchObject({ jsonrpc: "2.0", method: "initialize", params: { cwd: "/x" } });
    expect(typeof frame.id).toBe("string");
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { ok: true } }) + "\n");
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("error 响应 reject 为 DshRpcError", async () => {
    const { handle, stdout, stdin } = fakeHandle();
    const t = new JsonRpcTransport(handle);
    t.start();
    const p = t.request("session/fork", { parentSessionId: "s" });
    const frame = JSON.parse(stdin.writes[0]);
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -1, message: "bad boundary" } }) + "\n");
    await expect(p).rejects.toBeInstanceOf(DshRpcError);
  });

  it("notification 分发给监听器", async () => {
    const { handle, stdout } = fakeHandle();
    const t = new JsonRpcTransport(handle);
    t.start();
    const seen: Array<{ method: string; params: unknown }> = [];
    t.onNotification((method, params) => seen.push({ method, params }));
    stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s", event: { type: "turn/start" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("session.event");
  });
});
