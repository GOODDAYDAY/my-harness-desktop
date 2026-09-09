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
  const b = new DshBackend(t as unknown as JsonRpcTransport, { cwd: "/proj", provider: "p", model: "m", sessionId: "s-test" });
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
    expect(b.capabilities.thinking.missing.has("session/seed")).toBe(true);
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
    b.capabilities.thinking.onMissing = onMissing;
    await expect(b.setModel("p", "m")).resolves.toBeUndefined();
    expect(b.capabilities.thinking.missing.has("session/setModel")).toBe(true);
    expect(onMissing).toHaveBeenCalledWith("session/setModel");
  });

  it("supportsRuntimeSetModel 能力位:未探测过为 true(乐观),记缺面后翻 false", async () => {
    const { t, b } = makeBackend();
    expect(b.supportsRuntimeSetModel).toBe(true);
    t.errors.set("session/setModel", unknownMethod("session/setModel"));
    await b.setModel("p", "m2");
    expect(b.capabilities.thinking.missing.has("session/setModel")).toBe(true);
    expect(b.supportsRuntimeSetModel).toBe(false); // 壳据此把模型失配回落成停旧起新
  });

  it("非缺面错误(参数错)照常外抛,不记缺面", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/getTree", new DshRpcError("bad boundary", -1, "session/getTree"));
    await expect(b.getTree("s")).rejects.toThrow("bad boundary");
    expect(b.capabilities.thinking.missing.has("session/getTree")).toBe(false);
  });

  it("setSessionName 走 session/rename RPC(中立命名意图)", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/rename", {});
    await b.setSessionName("foo (copy)");
    expect(t.requests.some((r) => r.method === "session/rename")).toBe(true);
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
    // 根 lineageId ≡ neutralSessionId 不变量:seed 投影把活跃 lineage 重包成新会话的根,
    // neutralSessionId 必须 = lineageId(= dsh 会话 id),不是壳会话 ns(opts.neutralSessionId)
    expect(s.neutralSessionId).toBe("root");
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

  it("buildDshSeedSession 只投影对话角色:user/assistant/toolResult 之外的条目(分隔线/注解卡)不进内核", () => {
    const mixed: NeutralEntry[] = [
      ...entries,
      { neutralEntryId: "root:2", message: { role: "divider", content: "" } },
      { neutralEntryId: "root:3", message: { role: "goal_note", content: '{"action":"pause"}' } },
    ];
    const s = buildDshSeedSession(mixed, { neutralSessionId: "ns", lineageId: "root", header });
    expect(s.lineages[0].entries.map((e) => e.message.role)).toEqual(["user", "assistant"]);
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

  it("seed 成功后重绑 currentSessionId 为服务端返回的 id(=lineageId,身份断言通过)", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/seed", { sessionId: "root" });
    const id = await b.seed(entries, { neutralSessionId: "ns", lineageId: "root", header });
    expect(id).toBe("root");
    expect(b.sessionId).toBe("root");
  });

  it("seed 身份断言:服务端返回与 lineageId 不一致即抛错,不静默错绑", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/seed", { sessionId: "rebound-id" });
    await expect(b.seed(entries, { neutralSessionId: "ns", lineageId: "root", header })).rejects.toThrow(/身份断言失败/);
    expect(b.sessionId).toBe("s-test"); // 不重绑,保持构造时标识
  });

  it("构造缺 sessionId 直接抛错(桶名回落已删除,宁可早炸不串会话)", () => {
    const t = new FakeTransport();
    expect(() => new DshBackend(t as unknown as JsonRpcTransport, { cwd: "/proj", provider: "p", model: "m" })).toThrow(/缺少会话标识/);
  });
});

describe("dsh 思考深度补面(dsh-thinking-level.md)", () => {
  it("setThinkingLevel 发 session/setThinkingLevel RPC(热切,不重启)", async () => {
    const { t, b } = makeBackend();
    await b.setThinkingLevel("high");
    expect(t.requests.some((r) => r.method === "session/setThinkingLevel" && (r.params as { level?: string }).level === "high")).toBe(true);
  });

  it("setThinkingLevel 未物化会话(unknown session):暂存 pending,首个 prompt 落定后补发", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/setThinkingLevel", new Error("unknown session: s-test"));
    await b.setThinkingLevel("low"); // 不炸:暂存
    // 首个 prompt 后补发
    t.errors.delete("session/setThinkingLevel");
    await b.sendMessage("hi");
    expect(t.requests.some((r) => r.method === "session/setThinkingLevel" && (r.params as { level?: string }).level === "low")).toBe(true);
  });

  it("setThinkingLevel 旧适配插件缺面(unknown method):记缺面 + no-op,不打断发送", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/setThinkingLevel", unknownMethod("session/setThinkingLevel"));
    const onMissing = vi.fn();
    b.capabilities.thinking.onMissing = onMissing;
    await expect(b.setThinkingLevel("high")).resolves.toBeUndefined();
    expect(b.capabilities.thinking.missing.has("session/setThinkingLevel")).toBe(true);
    expect(onMissing).toHaveBeenCalledWith("session/setThinkingLevel");
  });

  it("setThinkingLevel 校验拒绝(模型不支持该档位):照常外抛,诚实立即反馈", async () => {
    const { t, b } = makeBackend();
    t.errors.set("session/setThinkingLevel", new DshRpcError('provider "p" model "m" does not support reasoning effort "xhigh"', -32000, "session/setThinkingLevel"));
    await expect(b.setThinkingLevel("xhigh")).rejects.toThrow(/does not support reasoning effort/);
  });

  it("getThinkingLevels 补面查询:答档位清单;缺面 → 空清单(壳藏控件)", async () => {
    const { t, b } = makeBackend();
    t.results.set("session/getThinkingLevels", { levels: ["off", "low", "high"] });
    await expect(b.capabilities.thinking.getThinkingLevels!()).resolves.toEqual(["off", "low", "high"]);
    // 缺面:unknown method → 空清单,不抛
    t.errors.set("session/getThinkingLevels", unknownMethod("session/getThinkingLevels"));
    const b2 = new DshBackend(t as unknown as JsonRpcTransport, { cwd: "/proj", provider: "p", model: "m", sessionId: "s-2" });
    await expect(b2.capabilities.thinking.getThinkingLevels!()).resolves.toEqual([]);
  });
});
