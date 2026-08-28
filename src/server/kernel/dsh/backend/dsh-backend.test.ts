// DshBackend 能力探测单测:懒探测(unknown method → 记缺面 + 清晰错误)、
// setModel 缺面 no-op 但不静默、非缺面错误照常外抛。用假 transport,不起真进程。
import { describe, it, expect, vi } from "vitest";
import { DshBackend, buildDshSeedSession } from "./dsh-backend";
import { DshRpcError } from "../protocol/json-rpc";
import type { JsonRpcTransport } from "../protocol/json-rpc";
import type { NeutralSession, NeutralEntry } from "@my-harness-desktop/shared";

/** 造一个 "unknown method" 的 DshRpcError(与服务端 handleRequest default 分支同文案)。 */
function unknownMethod(method: string): DshRpcError {
  return new DshRpcError(`unknown DeepSeek Harness SDK runtime method: ${method}`, -32601, method);
}

/** 假 transport:按 method 配置 result/error,记录 request 调用序列(方法名 + params)。 */
class FakeTransport {
  alive = true;
  requests: { method: string; params?: unknown }[] = [];
  errors = new Map<string, Error>();
  results = new Map<string, unknown>();
  start(): void {}
  async stop(): Promise<void> {}
  onNotification(): () => void { return () => {}; }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
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
    t.errors.set("session/getTree", unknownMethod("session/getTree"));
    await expect(b.getTree("s")).rejects.toThrow(/缺少 session\/getTree/);
    await expect(b.getTree("s")).rejects.toThrow(/缺少 session\/getTree/);
    // 第二次直接短路,不再发 request
    expect(t.requests.filter((r) => r.method === "session/getTree")).toHaveLength(1);
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
    t.errors.set("session/getTree", new DshRpcError("bad boundary", -1, "session/getTree"));
    await expect(b.getTree("s")).rejects.toThrow("bad boundary");
    expect(b.capabilities.dsh.missing.has("session/getTree")).toBe(false);
  });

  it("setSessionName 走 session/rename RPC(中立命名意图)", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/rename", {});
    await b.setSessionName("foo (copy)");
    expect(t.requests.some((r) => r.method === "session/rename")).toBe(true);
  });

  it("continue 走 session/continue RPC(第八意图)", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/continue", {});
    await b.continue();
    expect(t.requests.some((r) => r.method === "session/continue")).toBe(true);
  });

  it("continue 未知方法(旧 dsh 内核):记缺面 + 抛清晰错误", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/continue", unknownMethod("session/continue"));
    await expect(b.continue()).rejects.toThrow(/缺少 session\/continue/);
    expect(b.capabilities.dsh.missing.has("session/continue")).toBe(true);
  });
});

describe("dsh seed 转录(wire 形状对齐 session/seed 的 NeutralSessionWire 树)", () => {
  const header = { kernel: "pi" as const, cwd: "/proj", createdAt: "2025-01-01T00:00:00.000Z" };
  const entries: NeutralEntry[] = [
    { neutralEntryId: "root:0", kernelEntryId: "k0", message: { role: "user", content: "hi" } },
    {
      neutralEntryId: "root:1",
      kernelEntryId: "k1",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      display: { image: { src: "x.png" } }, // 展示元数据:转录时剥离
    },
  ];

  it("buildDshSeedSession 把线性 NeutralEntry[] 包回单 lineage 树(fork=null)", () => {
    const s = buildDshSeedSession(entries, { neutralSessionId: "ns", lineageId: "root", header });
    expect(s.neutralSessionId).toBe("ns");
    expect(s.header).toEqual(header);
    expect(s.lineages).toHaveLength(1);
    expect(s.lineages[0].lineageId).toBe("root");
    expect(s.lineages[0].fork).toBeNull();
    expect(s.lineages[0].entries).toHaveLength(2);
  });

  it("buildDshSeedSession 剥离 display(展示元数据不进内核投影)", () => {
    const s = buildDshSeedSession(entries, { neutralSessionId: "ns", lineageId: "root", header });
    expect(s.lineages[0].entries[1]).not.toHaveProperty("display");
    expect(s.lineages[0].entries[1]).toEqual({
      neutralEntryId: "root:1",
      kernelEntryId: "k1",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });
  });

  it("seed 发给 session/seed 的 session 参数是树,不是线性数组(回归护栏)", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/seed", { sessionId: "root" });
    await b.seed(entries, { neutralSessionId: "ns", lineageId: "root", header });
    const call = t.requests.find((r) => r.method === "session/seed");
    expect(call).toBeDefined();
    const params = call!.params as { sessionId: string; session: NeutralSession };
    expect(params.sessionId).toBe("root");
    // 关键:session 必须是 { neutralSessionId, lineages },不能是裸 NeutralEntry[]
    expect(Array.isArray(params.session)).toBe(false);
    expect(params.session.lineages).toBeDefined();
    expect(params.session.lineages[0].entries.map((e) => e.message.role)).toEqual(["user", "assistant"]);
  });

  it("seed 成功后重绑 currentSessionId 为服务端返回的 id", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/seed", { sessionId: "rebound-id" });
    const id = await b.seed(entries, { neutralSessionId: "ns", lineageId: "root", header });
    expect(id).toBe("rebound-id");
    expect(b.sessionId).toBe("rebound-id");
  });
});
