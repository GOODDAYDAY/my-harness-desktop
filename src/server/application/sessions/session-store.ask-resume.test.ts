// SessionStore ask 续问裸单测(docs/design/ask-design.md):落账准入/活路/续路/防重/
// prompt 前对账/水合查询/级联删除。fixture:tmp 目录真会话文件(含悬空 ask toolCall),
// FakeAdapter 捕获 extension_ui_response 帧与命令序列,不起真内核。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type BackendFactory } from "./session-store";
import { PiBackend, piSeedSession } from "../../kernel/pi/backend/pi-backend";
import { PiSessionCatalog } from "../../kernel/pi/backend/pi-catalog";
import { PendingQuestionStore } from "./pending-question-store";
import { NeutralSessionStore } from "./neutral-session-store";
import { ModelCatalog } from "../models/model-catalog";
import { PiModelSource } from "../../kernel/pi/model/pi-model-source";
import { ModelsStore } from "../../kernel/pi/model/models-store";
import { cwdToBucketName } from "@my-harness-desktop/shared";
import type { PendingQuestionRecord, Question } from "@my-harness-desktop/shared";
import type { RpcAdapter } from "../../kernel/pi/backend/rpc-adapter";
import type { RpcCommand } from "../../kernel/pi/protocol/rpc-types";
import type { SessionCatalogFactory } from "@my-harness-desktop/shared";

const CWD = "/tmp/proj";
const PROC_STATE = {
  model: { provider: "p", id: "a", name: "a" },
  thinkingLevel: "high", isStreaming: false, isCompacting: false,
  steeringMode: "all", followUpMode: "all", sessionId: "s1",
  autoCompactionEnabled: false, messageCount: 0, pendingMessageCount: 0,
};

/** 捕获型假适配器:记录命令序列 + extension_ui_response 帧,可手动发事件/帧。 */
class AskFakeAdapter {
  alive = false;
  stderr = "";
  sent: string[] = [];
  uiResponses: unknown[] = [];
  private eventCbs = new Set<(e: unknown) => void>();
  private extUiCbs = new Set<(r: unknown) => void>();
  async start(): Promise<void> { this.alive = true; }
  async stop(): Promise<void> { this.alive = false; }
  onEvent(cb: (e: unknown) => void): () => void { this.eventCbs.add(cb); return () => { this.eventCbs.delete(cb); }; }
  onBusFrame(): void {}
  onExtensionUI(cb: (r: unknown) => void): () => void { this.extUiCbs.add(cb); return () => { this.extUiCbs.delete(cb); }; }
  sendExtensionUIResponse(res: unknown): void { this.uiResponses.push(res); }
  /** 模拟内核发事件(走 PiBackend.onEvent → translateEvent → dispatch)。 */
  emitEvent(e: unknown): void { for (const cb of this.eventCbs) cb(e); }
  /** 模拟内核写 extension_ui_request 帧(走 PiBackend.onQuestion → 落账/投递)。 */
  emitFrame(r: unknown): void { for (const cb of this.extUiCbs) cb(r); }
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

const QUESTIONS: Question[] = [{ id: "q1", question: "选哪个？", options: [{ label: "A 方案" }, { label: "B 方案" }] }];

function mkRecord(over: Partial<PendingQuestionRecord> = {}): PendingQuestionRecord {
  return {
    requestId: "req-1", kernel: "pi", neutralSessionId: "s1", cwd: CWD,
    sessionKey: "", procNonce: "dead-proc", toolCallId: "call_1",
    model: { provider: "p", modelId: "a" },
    questions: QUESTIONS, status: "pending", createdAt: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

let dir: string;
let sessionPath: string;
let adapter: AskFakeAdapter;
let store: SessionStore;
let questionStore: PendingQuestionStore;
let neutralStore: NeutralSessionStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "session-store-ask-"));
  const bucket = join(dir, "sessions", cwdToBucketName(CWD));
  mkdirSync(bucket, { recursive: true });
  sessionPath = join(bucket, "s1.jsonl");
  writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s1", cwd: CWD, "custom-my-harness-desktop": { kernel: "pi" } }) + "\n");
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "a" }] } } }));
  adapter = new AskFakeAdapter();
  neutralStore = new NeutralSessionStore(join(dir, "neutral"));
  questionStore = new PendingQuestionStore(join(dir, "pending-questions"));
  const factory: BackendFactory = {
    create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: dir, sessionId: sessionPath }),
    // 忠实 pi 形态(session-single-source §4.4):factory 有 seed 面 → createProc 的
    // materializedLineageId 初始化为 ns(文件已含内容,不重投);无 seed 面会被当成
    // dsh 类内核,首发经 materializeActiveLineage 从中立层重写会话文件。
    seed: (lineage, opts) => piSeedSession(dir, opts.cwd, lineage, opts),
  };
  const catalogFactory: SessionCatalogFactory = { create: () => new PiSessionCatalog(dir) };
  store = new SessionStore(factory, catalogFactory, () => ({ sessionRoots: [join(dir, "sessions")], ids: ["pi"] }), undefined, neutralStore,
    new ModelCatalog(() => [new PiModelSource(new ModelsStore({ agentDir: dir }))]), undefined, questionStore);
  store.setContext(CWD, sessionPath);
  await store.start(CWD, sessionPath);
  adapter.sent = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写一条含悬空 ask toolCall 的会话历史(user → assistant(toolCall,无配对 toolResult))。 */
function writeDanglingToolCall(): void {
  writeFileSync(sessionPath, [
    JSON.stringify({ type: "session", id: "s1", cwd: CWD, "custom-my-harness-desktop": { kernel: "pi" } }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-02T00:00:00.000Z", message: { role: "user", content: "帮我选个方案" } }),
    JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-02T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "ask_user_question", arguments: JSON.stringify({ questions: QUESTIONS }) }] } }),
  ].join("\n") + "\n");
}

/** 读会话文件里 role=toolResult 的条目。 */
function toolResultsOf(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((j) => j.type === "message" && (j.message as { role?: unknown }).role === "toolResult");
}

describe("ask 落账(准入 + 真实 q.id 对账)", () => {
  it("对账到 ask toolCallStart 的帧:落账且 questions 用真实 q.id(帧合成 id 被替换)", () => {
    adapter.emitEvent({ type: "tool_execution_start", toolCallId: "call_1", toolName: "ask_user_question", args: { questions: QUESTIONS } });
    adapter.emitFrame({ type: "extension_ui_request", id: "req-1", method: "select", title: "选哪个？", options: ["A 方案", "B 方案"] });
    const rec = questionStore.get("req-1");
    expect(rec).not.toBeNull();
    expect(rec!.toolCallId).toBe("call_1");
    expect(rec!.kernel).toBe("pi");
    expect(rec!.neutralSessionId).toBe("s1");
    expect(rec!.questions[0]!.id).toBe("q1"); // 真实 q.id,不是帧的 req-1-0
    expect(rec!.status).toBe("pending");
  });

  it("对不上 ask toolCallStart 的帧:只投递不落账(防误持久化)", () => {
    const got: unknown[] = [];
    store.onQuestion((q) => got.push(q));
    adapter.emitFrame({ type: "extension_ui_request", id: "req-x", method: "select", title: "别的扩展的问题", options: ["A"] });
    expect(questionStore.has("req-x")).toBe(false);
    expect(got).toHaveLength(1); // 维持瞬态投递
  });
});

describe("answerQuestion 分流", () => {
  it("活路:nonce 匹配且进程活着 → extension_ui_response 帧 + delivered", async () => {
    adapter.emitEvent({ type: "tool_execution_start", toolCallId: "call_1", toolName: "ask_user_question", args: { questions: QUESTIONS } });
    adapter.emitFrame({ type: "extension_ui_request", id: "req-1", method: "select", title: "选哪个？", options: ["A 方案", "B 方案"] });
    await store.answerQuestion("req-1", [{ id: "q1", selected: ["A 方案"] }]);
    expect(adapter.uiResponses).toHaveLength(1);
    expect(adapter.uiResponses[0]).toMatchObject({ type: "extension_ui_response", id: "req-1", value: "A 方案" });
    const rec = questionStore.get("req-1")!;
    expect(rec.status).toBe("answered");
    expect(rec.delivered).toBe(true);
  });

  it("防重:已作答的记录第二次作答抛错(幂等防线)", async () => {
    adapter.emitEvent({ type: "tool_execution_start", toolCallId: "call_1", toolName: "ask_user_question", args: { questions: QUESTIONS } });
    adapter.emitFrame({ type: "extension_ui_request", id: "req-1", method: "select", title: "选哪个？", options: ["A 方案"] });
    await store.answerQuestion("req-1", [{ id: "q1", selected: ["A 方案"] }]);
    await expect(store.answerQuestion("req-1", [{ id: "q1", selected: ["B 方案"] }])).rejects.toThrow("已作答");
  });

  it("续路 pi:发起进程已死(nonce 不匹配)→ 真 toolResult 落盘 + 回填消息触发新回合 + delivered", async () => {
    writeDanglingToolCall();
    questionStore.put(mkRecord({ sessionKey: sessionPath }));
    await store.answerQuestion("req-1", [{ id: "q1", selected: ["B 方案"] }]);
    // 会话文件落真 toolResult(role/toolCallId/答案 JSON/isError:false)
    const results = toolResultsOf(sessionPath);
    expect(results).toHaveLength(1);
    const msg = results[0]!.message as Record<string, unknown>;
    expect(msg.toolCallId).toBe("call_1");
    expect(msg.isError).toBe(false);
    expect((msg.content as { text: string }[])[0]!.text).toBe(JSON.stringify({ answers: [{ id: "q1", selected: ["B 方案"] }] }));
    // 中立层双写(刷新/冷开一致)
    const neutral = neutralStore.get("s1")!;
    const neutralResults = neutral.lineages.flatMap((l) => l.entries).filter((e) => e.message.role === "toolResult");
    expect(neutralResults.length).toBeGreaterThan(0);
    // 回填消息触发新回合(发了 prompt)
    expect(adapter.sent).toContain("prompt");
    expect(questionStore.get("req-1")!.delivered).toBe(true);
  });

  it("续路锚点不在(toolCallId 不在会话文件里):不落盘、降级为回填消息", async () => {
    writeDanglingToolCall();
    questionStore.put(mkRecord({ sessionKey: sessionPath, toolCallId: "call_ghost" }));
    await store.answerQuestion("req-1", [{ id: "q1", selected: ["A 方案"] }]);
    expect(toolResultsOf(sessionPath)).toHaveLength(0); // 没落盘
    expect(adapter.sent).toContain("prompt"); // 降级回填消息仍触发新回合
    expect(questionStore.get("req-1")!.delivered).toBe(true);
  });
});

describe("prompt 发送前对账(§6.6)", () => {
  it("nonce 不匹配的 pending 记录:先落 cancelled toolResult 闭合,再正常发送", async () => {
    writeDanglingToolCall();
    questionStore.put(mkRecord({ sessionKey: sessionPath }));
    await store.prompt("不用答了，直接继续", undefined, undefined, { provider: "p", modelId: "a", kernel: "pi", thinkingLevel: "" });
    const results = toolResultsOf(sessionPath);
    expect(results).toHaveLength(1);
    const msg = results[0]!.message as Record<string, unknown>;
    expect(msg.toolCallId).toBe("call_1");
    expect(msg.isError).toBe(true); // cancelled 闭合形状
    expect((msg.content as { text: string }[])[0]!.text).toBe("User cancelled the question");
    expect(questionStore.get("req-1")!.status).toBe("cancelled");
    expect(adapter.sent).toContain("prompt"); // 发送照常
  });
});

describe("水合与级联", () => {
  it("getPendingQuestions:返回激活会话的 pending 记录(卡片复活查询通道)", async () => {
    questionStore.put(mkRecord({ sessionKey: sessionPath }));
    questionStore.put(mkRecord({ requestId: "req-2", status: "answered", delivered: true }));
    const pending = await store.getPendingQuestions();
    expect(pending.map((r) => r.requestId)).toEqual(["req-1"]);
  });

  it("setContext 激活时重投 pending(卡片原地复活的事件通道)", async () => {
    questionStore.put(mkRecord({ sessionKey: sessionPath }));
    const got: unknown[] = [];
    store.onQuestion((q) => got.push(q));
    store.setContext(CWD, sessionPath); // 重新激活 → 水合重投
    expect(got).toHaveLength(1);
    expect((got[0] as { requestId: string }).requestId).toBe("req-1");
  });

  it("deleteSessions 级联删该会话的全部提问记录", async () => {
    questionStore.put(mkRecord({ sessionKey: sessionPath }));
    store.setContext(CWD, null); // 先切走(活跃会话禁删)
    await store.deleteSessions([sessionPath]);
    expect(questionStore.listBySession("s1")).toHaveLength(0);
  });

  it("injectQuestion 查重:已结算的记录重投被跳过(桥重启全量重扫的孤儿文件)", () => {
    questionStore.put(mkRecord({ sessionKey: sessionPath, status: "cancelled", answeredAt: "2026-09-02T00:00:01.000Z" }));
    const got: unknown[] = [];
    const off = store.onQuestion((q) => got.push(q));
    store.injectQuestion({ kind: "question", requestId: "req-1", sessionKey: "", questions: [{ id: "q1", question: "选哪个" }] });
    off();
    expect(got).toHaveLength(0); // 已结算不重复投递
    expect(questionStore.get("req-1")!.status).toBe("cancelled"); // 也不被重置回 pending
  });
});
