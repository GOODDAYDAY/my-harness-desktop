// 写穿收口单测(session-single-source §4.1):
// - messageEnd 是内容落中立层的主触发(两内核同口径);
// - entryAppended 降级为回填/补漏(幂等:同 kernelEntryId 不双写;无 id 条目绑权威 id);
// - 用户消息:乐观写入 → 回执回填,不双写;steer 注入(无乐观写)落一条;
// - 压缩边界条目:compactionEnd 事件落一条 compaction 分隔线(摘要随载荷)。
// fixture:tmp 目录真会话文件 + 可发射事件的 FakeAdapter,不 mock 框架。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type BackendFactory } from "./session-store";
import { PiBackend } from "../../kernel/pi/backend/pi-backend";
import { PiSessionCatalog } from "../../kernel/pi/backend/pi-catalog";
import { cwdToBucketName } from "@my-harness-desktop/shared";
import type { RpcAdapter } from "../../kernel/pi/backend/rpc-adapter";
import type { RpcCommand } from "../../kernel/pi/protocol/rpc-types";
import type { BaseBackend, SessionCatalogFactory, LineageTree, Anchor, NeutralMessage } from "@my-harness-desktop/shared";
import { NeutralSessionStore } from "./neutral-session-store";
import { ModelCatalog } from "../models/model-catalog";
import { PiModelSource } from "../../kernel/pi/model/pi-model-source";
import { ModelsStore } from "../../kernel/pi/model/models-store";

const CWD = "/tmp/proj";
const PROC_STATE = {
  model: { provider: "p", id: "a", name: "a" },
  thinkingLevel: "high",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  sessionId: "s1",
  autoCompactionEnabled: false,
  messageCount: 0,
  pendingMessageCount: 0,
};

/** 可发射事件的假适配器:捕获 onEvent 回调,emit 原始 pi 事件(snake_case 线格式)。 */
class FakeAdapter {
  alive = false;
  stderr = "";
  sent: string[] = [];
  private cb: ((event: unknown) => void) | null = null;
  async start(): Promise<void> { this.alive = true; }
  async stop(): Promise<void> { this.alive = false; }
  onEvent(cb: (event: never) => void): () => void {
    this.cb = cb as (event: unknown) => void;
    return () => { this.cb = null; };
  }
  onBusFrame(): void {}
  onExtensionUI(): void {}
  emit(event: Record<string, unknown>): void { this.cb?.(event); }
  async send(command: RpcCommand): Promise<unknown> {
    this.sent.push(command.type);
    switch (command.type) {
      case "get_state": return { success: true, data: { ...PROC_STATE } };
      case "get_entries": return { success: true, data: { entries: [], leafId: null } };
      case "get_tree": return { success: true, data: { tree: [], leafId: null } };
      case "get_commands": return { success: true, data: { commands: [] } };
      default: return { success: true, data: {} };
    }
  }
}

let dir: string;
let neutralStore: NeutralSessionStore;
let adapter: FakeAdapter;
let store: SessionStore;
const ns = "s1";
const catalogFactory: SessionCatalogFactory = { create: () => new PiSessionCatalog(dir) };

function entries(): { role: string; kernelEntryId?: string; content: unknown; timestamp?: number; startedAt?: number; kind?: string; detail?: string }[] {
  const s = neutralStore.get(ns);
  if (!s) return [];
  const lineage = s.lineages.find((l) => l.lineageId === ns) ?? s.lineages[0];
  return (lineage?.entries ?? []).map((e) => ({
    role: e.message.role,
    kernelEntryId: e.kernelEntryId,
    content: e.message.content,
    timestamp: e.message.timestamp,
    startedAt: e.message.startedAt,
    kind: (e.message as { kind?: string }).kind,
    detail: (e.message as { detail?: string }).detail,
  }));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "session-store-wt-"));
  const bucket = join(dir, "sessions", cwdToBucketName(CWD));
  mkdirSync(bucket, { recursive: true });
  writeFileSync(join(bucket, "s1.jsonl"), JSON.stringify({ type: "session", id: "s1", cwd: CWD, "custom-my-harness-desktop": { kernel: "pi" } }) + "\n");
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "a" }] } } }));
  neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "wt-neutral-")));
  adapter = new FakeAdapter();
  const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
  store = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
  store.setContext(CWD, join(bucket, "s1.jsonl"));
  await store.start(CWD, join(bucket, "s1.jsonl"));
  adapter.sent = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("写穿:messageEnd 是内容落中立层的主触发", () => {
  it("assistant 定稿 messageEnd → 落中立层;timestamp=写穿时刻,startedAt=内核开始时间", () => {
    const t0 = 1_700_000_000_000;
    adapter.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    adapter.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "答" }], timestamp: t0 } });
    const es = entries();
    expect(es.filter((e) => e.role === "assistant")).toHaveLength(1);
    const a = es.find((e) => e.role === "assistant")!;
    expect(a.startedAt).toBe(t0); // 内核 message.timestamp(LLM 开始)→ startedAt
    expect(typeof a.timestamp).toBe("number");
    expect(a.timestamp).toBeGreaterThan(t0); // timestamp=壳写穿时刻(完成时间)
  });

  it("幂等:entryAppended 同 kernelEntryId 不双写;无 id 写后由 entryAppended 绑权威 id", () => {
    // pi 的 message 无条目 id:先落(kernelEntryId 缺),补丁的 entry_appended 回填权威 id
    adapter.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "答" }] } });
    adapter.emit({ type: "entry_appended", entry: { id: "e1", type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "答" }] } } });
    let es = entries().filter((e) => e.role === "assistant");
    expect(es).toHaveLength(1);
    expect(es[0].kernelEntryId).toBe("e1");
    // 重复到达同 id 的 entryAppended → 跳过,不双写
    adapter.emit({ type: "entry_appended", entry: { id: "e1", type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "答" }] } } });
    es = entries().filter((e) => e.role === "assistant");
    expect(es).toHaveLength(1);
  });

  it("用户消息:prompt 乐观写入 → messageEnd 回放不双写 → entryAppended 回填权威 id", async () => {
    await store.prompt("你好", undefined, undefined, { provider: "p", modelId: "a", thinkingLevel: "", kernel: "pi" });
    expect(entries().filter((e) => e.role === "user")).toHaveLength(1); // 乐观写入
    // 内核回放(messageEnd 无条目 id):不双写
    adapter.emit({ type: "message_end", message: { role: "user", content: "你好" } });
    expect(entries().filter((e) => e.role === "user")).toHaveLength(1);
    // 权威回执(补丁的 entry_appended 带 id):回填
    adapter.emit({ type: "entry_appended", entry: { id: "u1", type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "你好" } } });
    const us = entries().filter((e) => e.role === "user");
    expect(us).toHaveLength(1);
    expect(us[0].kernelEntryId).toBe("u1");
    expect(typeof us[0].timestamp).toBe("number");
  });

  it("steer 注入的用户消息(无乐观写入):messageEnd 落一条", async () => {
    await store.prompt("首发", undefined, undefined, { provider: "p", modelId: "a", thinkingLevel: "", kernel: "pi" });
    await store.steer("插队指令");
    adapter.emit({ type: "message_end", message: { role: "user", content: "插队指令" } });
    const us = entries().filter((e) => e.role === "user");
    expect(us.map((e) => e.content)).toEqual(["首发", "插队指令"]);
  });

  it("压缩结束:compactionEnd → 落一条 compaction 分隔线(摘要随事件载荷)", () => {
    adapter.emit({ type: "compaction_start" });
    adapter.emit({ type: "compaction_end", summary: "摘要:聊过天气", tokensBefore: 12345 });
    const comp = entries().find((e) => e.role === "divider" && e.kind === "compaction");
    expect(comp).toBeDefined();
    expect(comp!.detail).toBe("摘要:聊过天气"); // 摘要落库,作 seed 投影的截断代身
  });

  it("clone 归壳:中立层整树复制 + 新 ns,内核零参与(§4.2)", async () => {
    await store.prompt("问", undefined, undefined, { provider: "p", modelId: "a", thinkingLevel: "", kernel: "pi" });
    adapter.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "答" }] } });
    const rpcBefore = adapter.sent.length;
    await store.clone();
    // 内核零参与:clone 全程没有发任何 RPC
    expect(adapter.sent.length).toBe(rpcBefore);
    const sessions = neutralStore.listByCwd(CWD);
    expect(sessions).toHaveLength(2);
    const cloned = sessions.find((x) => x.header.name?.includes("(copy)"));
    expect(cloned).toBeTruthy();
    expect(cloned!.neutralSessionId).not.toBe(ns);
    // 内容整树复制(对话条目同文)——摘要不带 entries(§neutral-storage-split §2.3),走 get 全量读
    const clonedFull = neutralStore.get(cloned!.neutralSessionId)!;
    const clonedConvo = clonedFull.lineages.flatMap((l) => l.entries).filter((e) => e.message.role === "user" || e.message.role === "assistant");
    expect(clonedConvo.map((e) => e.message.role)).toEqual(["user", "assistant"]);
    // 克隆条目不携带源会话的内核 id(目标内核 seed 时重分配)
    expect(clonedConvo.every((e) => e.kernelEntryId === undefined)).toBe(true);
  });

  it("sync 内容基线从中立层出(§4.2):pi 的 get_entries 返回空也照见中立层内容", async () => {
    await store.prompt("问", undefined, undefined, { provider: "p", modelId: "a", thinkingLevel: "", kernel: "pi" });
    adapter.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "答" }] } });
    const snapshot = await store.sync();
    // FakeAdapter 的 get_entries 恒空——基线里的内容只能来自中立层(单源的证据);
    // 分隔线(模型切换/自动命名)也是中立层内容,按对话 role 过滤断言。
    const convo = snapshot.messages.filter((m) => m.role === "user" || m.role === "assistant");
    expect(convo.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(convo[1].content).toEqual([{ type: "text", text: "答" }]);
  });
});

describe("sync 对无快照面内核(dsh 形态)也产基线:内容中立层 + 状态壳记账", () => {
  class FakeDsh {
    alive = false;
    capabilities = {};
    calls: string[] = [];
    private cb: ((e: unknown) => void) | null = null;
    constructor(public sessionId?: string) {}
    async start(): Promise<void> { this.alive = true; }
    async stop(): Promise<void> { this.alive = false; }
    onEvent(cb: (e: never) => void): () => void { this.cb = cb as (e: unknown) => void; return () => { this.cb = null; }; }
    emit(e: Record<string, unknown>): void { this.cb?.(e); }
    async sendMessage(): Promise<void> { this.calls.push("sendMessage"); }
    async setModel(): Promise<void> {}
    async setSessionName(): Promise<void> {}
    async seed(): Promise<string> { return this.sessionId ?? "s"; }
    async getTree(): Promise<LineageTree> { return { rootId: "", lineages: [] }; }
    async getEntries(): Promise<NeutralMessage[]> { return []; }
    async bookmark(): Promise<Anchor> { return { lineageId: "", entryId: "" } as Anchor; }
    async deleteBookmark(): Promise<void> {}
    async abort(): Promise<void> {}
  }

  it("dsh 形态:sync 产基线且消息来自中立层(不再降级返回旧基线)", async () => {
    const dsh = new FakeDsh("ns-dsh");
    const factory: BackendFactory = { create: () => dsh as unknown as BaseBackend };
    const dshSource = { listModels: () => [{ kernel: "dsh" as const, provider: "p", id: "a", name: "a" }] };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([dshSource]));
    s.setContext(CWD, null);
    await s.prompt("问", undefined, undefined, { provider: "p", modelId: "a", thinkingLevel: "", kernel: "dsh" });
    dsh.emit({ type: "messageEnd", message: { role: "assistant", content: [{ type: "text", text: "答" }] } });
    const snapshot = await s.sync();
    const convo = snapshot.messages.filter((m) => m.role === "user" || m.role === "assistant");
    expect(convo.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(snapshot.state.sessionId).toBe("ns-dsh");
  });
});
