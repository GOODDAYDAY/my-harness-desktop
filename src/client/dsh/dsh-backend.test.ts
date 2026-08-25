// DshBackend 能力探测单测:懒探测(unknown method → 记缺面 + 清晰错误)、
// setModel 缺面 no-op 但不静默、非缺面错误照常外抛。用假 transport,不起真进程。
import { describe, it, expect, vi } from "vitest";
import { DshBackend } from "./dsh-backend";
import { DshRpcError } from "./json-rpc";
import type { JsonRpcTransport } from "./json-rpc";
import type { NeutralSession } from "../../core/domain/session-neutral";

/** 造一个 "unknown method" 的 DshRpcError(与服务端 handleRequest default 分支同文案)。 */
function unknownMethod(method: string): DshRpcError {
  return new DshRpcError(`unknown DeepSeek Harness SDK runtime method: ${method}`, -32601, method);
}

/** 假 transport:按 method 配置 result/error,记录 request 调用序列。 */
class FakeTransport {
  alive = true;
  requests: string[] = [];
  errors = new Map<string, Error>();
  results = new Map<string, unknown>();
  start(): void {}
  async stop(): Promise<void> {}
  onNotification(): () => void { return () => {}; }
  async request<T>(method: string, _params?: unknown): Promise<T> {
    this.requests.push(method);
    const err = this.errors.get(method);
    if (err) throw err;
    return this.results.get(method) as T;
  }
}

function makeBackend(): { t: FakeTransport; b: DshBackend } {
  const t = new FakeTransport();
  const b = new DshBackend(t as unknown as JsonRpcTransport, { cwd: "/proj", provider: "p", model: "m" });
  return { t, b };
}

const session: NeutralSession = {
  neutralSessionId: "ns",
  header: { kernel: "pi", cwd: "/proj", createdAt: new Date().toISOString() },
  lineages: [],
};

describe("DshBackend 能力探测(懒探测 + 显式降级)", () => {
  it("seed 首次 unknown method:记缺面 + 抛清晰错误,不裸炸", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/seed", unknownMethod("session/seed"));
    await expect(b.seed([], { neutralSessionId: "ns", lineageId: "root", header: session.header })).rejects.toThrow(/缺少 session\/seed/);
    expect(b.capabilities.dsh.missing.has("session/seed")).toBe(true);
  });

  it("已知缺面的方法不再重调,直接抛清晰错误", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/fork", unknownMethod("session/fork"));
    await expect(b.fork("p")).rejects.toThrow(/缺少 session\/fork/);
    await expect(b.fork("p")).rejects.toThrow(/缺少 session\/fork/);
    // 第二次直接短路,不再发 request
    expect(t.requests.filter((m) => m === "session/fork")).toHaveLength(1);
  });

  it("setModel unknown method:no-op 不抛,但记缺面 + 触发 onMissing", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/setModel", unknownMethod("session/setModel"));
    const onMissing = vi.fn();
    b.capabilities.dsh.onMissing = onMissing;
    await expect(b.setModel("p", "m")).resolves.toBeUndefined();
    expect(b.capabilities.dsh.missing.has("session/setModel")).toBe(true);
    expect(onMissing).toHaveBeenCalledWith("session/setModel");
  });

  it("非缺面错误(参数错)照常外抛,不记缺面", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/fork", new DshRpcError("bad boundary", -1, "session/fork"));
    await expect(b.fork("p")).rejects.toThrow("bad boundary");
    expect(b.capabilities.dsh.missing.has("session/fork")).toBe(false);
  });

  it("fork 成功返回 ForkResult(lineageId + sessionReplaced=false)", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/fork", { lineageId: "child-1" });
    const res = await b.fork("parent", "3");
    expect(res).toEqual({ lineageId: "child-1", sessionReplaced: false });
    expect(t.requests.filter((m) => m === "session/fork")).toHaveLength(1);
  });

  it("setSessionName 走 session/rename RPC(中立命名意图)", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/rename", {});
    await b.setSessionName("foo (copy)");
    expect(t.requests).toContain("session/rename");
  });

  it("continue 走 session/continue RPC(第八意图)", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/continue", {});
    await b.continue();
    expect(t.requests).toContain("session/continue");
  });

  it("continue 未知方法(旧 dsh 内核):记缺面 + 抛清晰错误", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/continue", unknownMethod("session/continue"));
    await expect(b.continue()).rejects.toThrow(/缺少 session\/continue/);
    expect(b.capabilities.dsh.missing.has("session/continue")).toBe(true);
  });
});
