// 网关编排单测(web-service-architecture.md §19/§32)。
// 纯逻辑、零 mock 外部环境:dispatch 分发表 / 鉴权状态机 / 广播扇出 / sink 回收。

import { describe, it, expect } from "vitest";
import { createGateway, type Gateway } from "./gateway";
import type { Conn, WireMessage } from "../../domain/remote";
import type { Host } from "../../domain/host";

/** 缺省 Host 桩:本测试不碰宿主能力,host 只作 Conn 的占位。 */
const hostStub = {} as Host;

function makeConn(authenticated = false, kind: "local" | "remote" = "local"): Conn {
  return { id: `c-${Math.random().toString(36).slice(2, 8)}`, kind, host: hostStub, authenticated };
}

/** 阶段 1 的本地 token 校验:只认固定 token。 */
const localToken: (t: string) => "local" | null = (t) => (t === "secret" ? "local" : null);

describe("gateway 分发表 + 鉴权 + 广播", () => {
  it("register 后 dispatch 返回 ok 结果,handler 拿到 args + conn", async () => {
    const g = createGateway(localToken);
    const conn = makeConn(true);
    let seen: unknown = null;
    g.register("echo", (c, ...args) => {
      seen = { args, conn: c };
      return args[0];
    });
    const res = await g.dispatch(conn, { kind: "invoke", id: 1, channel: "echo", args: ["hi", 42] });
    expect(res).toEqual({ kind: "result", id: 1, ok: true, result: "hi" });
    expect(seen).toMatchObject({ args: ["hi", 42], conn });
  });

  it("handler 抛错 → ok:false HANDLER_ERROR,不静默", async () => {
    const g = createGateway(localToken);
    g.register("boom", () => { throw new Error("内核崩了"); });
    const res = await g.dispatch(makeConn(true), { kind: "invoke", id: 2, channel: "boom", args: [] });
    expect(res.ok).toBe(false);
    expect((res as { error?: { code?: string } }).error?.code).toBe("HANDLER_ERROR");
    expect((res as { error?: { message?: string } }).error?.message).toContain("内核崩了");
  });

  it("未知 channel → UNKNOWN_CHANNEL(§6.4 不静默)", async () => {
    const g = createGateway(localToken);
    const res = await g.dispatch(makeConn(true), { kind: "invoke", id: 3, channel: "nope", args: [] });
    expect(res.ok).toBe(false);
    expect((res as { error?: { code?: string } }).error?.code).toBe("UNKNOWN_CHANNEL");
  });

  it("未鉴权 dispatch → AUTH_REQUIRED(§19.2)", async () => {
    const g = createGateway(localToken);
    g.register("echo", (_conn, ...args) => args[0]);
    const res = await g.dispatch(makeConn(false), { kind: "invoke", id: 4, channel: "echo", args: ["x"] });
    expect(res.ok).toBe(false);
    expect((res as { error?: { code?: string } }).error?.code).toBe("AUTH_REQUIRED");
  });

  it("authenticate 校验 token:通过标记身份+已鉴权,失败不动", async () => {
    const g = createGateway(localToken);
    const conn = makeConn(false);
    expect(g.authenticate(conn, "secret")).toBe(true);
    expect(conn).toMatchObject({ authenticated: true, kind: "local" });
    const conn2 = makeConn(false);
    expect(g.authenticate(conn2, "wrong")).toBe(false);
    expect(conn2).toMatchObject({ authenticated: false });
  });

  it("broadcast 扇出到每个已鉴权 sink,push 带 channel + args(§19.4)", () => {
    const g = createGateway(localToken);
    const got: WireMessage[] = [];
    const off = g.addSink((m) => got.push(m));
    g.broadcast("session:event", { type: "x" }, 1);
    expect(got).toEqual([{ kind: "push", channel: "session:event", args: [{ type: "x" }, 1] }]);
    off();
    g.broadcast("session:event", { type: "y" });
    expect(got).toHaveLength(1); // 取消后不再收到
  });

  it("channelCount/connectionCount 反映注册数与连接数(/status.json)", () => {
    const g = createGateway(localToken);
    expect(g.channelCount()).toBe(0);
    g.register("a", () => {});
    g.register("b", () => {});
    expect(g.channelCount()).toBe(2);
    const off = g.addSink(() => {});
    expect(g.connectionCount()).toBe(1);
    off();
    expect(g.connectionCount()).toBe(0);
  });
});
