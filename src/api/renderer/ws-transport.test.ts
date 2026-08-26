// wsTransport 单测(web-service-architecture.md §32.1)——invoke/result 配对 + push 派发 + off。
// 用桩 WebSocket 模拟收帧,不碰真实网络。

import { describe, it, expect, vi } from "vitest";
import { wsTransport } from "./ws-transport";

/** 最小 WebSocket 桩:只实现 addEventListener + send。 */
class FakeWebSocket {
  listeners = new Map<string, Set<(ev: { data: string }) => void>>();
  sent: string[] = [];
  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(cb);
  }
  send(text: string) {
    this.sent.push(text);
  }
  emit(type: string, data: string) {
    for (const cb of this.listeners.get(type) ?? []) cb({ data });
  }
}

function make() {
  const ws = new FakeWebSocket();
  const t = wsTransport(ws as unknown as WebSocket);
  return { ws, t };
}

describe("wsTransport", () => {
  it("invoke 发送 invoke 帧,按 id 配对 result resolve", async () => {
    const { ws, t } = make();
    const p = t.invoke("session:prompt", "hi");
    expect(ws.sent).toEqual([JSON.stringify({ kind: "invoke", id: 1, channel: "session:prompt", args: ["hi"] })]);
    ws.emit("message", JSON.stringify({ kind: "result", id: 1, ok: true, result: 42 }));
    await expect(p).resolves.toBe(42);
  });

  it("result ok:false → reject(Error(message))", async () => {
    const { ws, t } = make();
    const p = t.invoke("x");
    ws.emit("message", JSON.stringify({ kind: "result", id: 1, ok: false, error: { message: "崩了" } }));
    await expect(p).rejects.toThrow("崩了");
  });

  it("push 按 channel 派发到订阅者,off 后不再收", () => {
    const { ws, t } = make();
    const got: unknown[] = [];
    const cb = (...a: unknown[]) => got.push(a);
    const off = t.on("session:event", cb);
    ws.emit("message", JSON.stringify({ kind: "push", channel: "session:event", args: [{ type: "x" }] }));
    expect(got).toEqual([[{ type: "x" }]]);
    off();
    ws.emit("message", JSON.stringify({ kind: "push", channel: "session:event", args: [{ type: "y" }] }));
    expect(got).toHaveLength(1);
  });

  it("坏帧忽略不炸传输", () => {
    const { ws, t } = make();
    const cb = vi.fn();
    t.on("a", cb);
    expect(() => ws.emit("message", "not-json")).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});
