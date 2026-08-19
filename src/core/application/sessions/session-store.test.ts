// SessionStore 差量执行裸单测(docs/design/session-model-config.md §4.3):
// setModel/setThinkingLevel 经 ensureForSend 拿到实证快照后,进程已持目标值即跳过 RPC
// (同值 set_model 会在时间线落 model_change 分隔线);实况有差或快照缺失才发。
// fixture:tmp 目录真会话文件(updateSessionHeader 要求头行真实存在);FakeAdapter
// 记录发出的命令 type,不 mock 框架。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type BackendFactory } from "./session-store";
import { PiBackend } from "../../../client/pi/pi-backend";
import { PiSessionCatalog } from "../../../client/pi/pi-catalog";
import { cwdToBucketName } from "../../domain/sessions";
import type { RpcAdapter } from "../../../client/pi/rpc-adapter";
import type { RpcCommand } from "../../protocol/rpc-types";
import type { BaseBackend, LineageTree, Anchor, BoundaryRef, SessionCatalogFactory } from "../../domain/backend";
import type { NeutralMessage } from "../../domain/events/session-state";

/** 目录/CRUD 工厂:真实 PiSessionCatalog(读测试 agentDir 的 JSONL)。openSession 等测试依赖真实目录读。 */
const catalogFactory: SessionCatalogFactory = {
  create: () => new PiSessionCatalog(dir),
};

const CWD = "/tmp/proj";
/** FakeAdapter 的固定进程实况:p/a @ high(get_state 永远回答这份)。 */
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

class FakeAdapter {
  alive = false;
  stderr = "";
  /** 已发命令 type 序列(get_state 等探测命令也记录,断言按类型筛)。 */
  sent: string[] = [];
  async start(): Promise<void> {
    this.alive = true;
  }
  async stop(): Promise<void> {
    this.alive = false;
  }
  onEvent(): void {}
  onBusFrame(): void {}
  onExtensionUI(): void {}
  async send(command: RpcCommand): Promise<unknown> {
    this.sent.push(command.type);
    switch (command.type) {
      case "get_state":
        return { success: true, data: { ...PROC_STATE } };
      case "get_entries":
        return { success: true, data: { entries: [], leafId: null } };
      case "get_tree":
        return { success: true, data: { tree: [], leafId: null } };
      case "get_commands":
        return { success: true, data: { commands: [] } };
      default:
        return { success: true, data: {} };
    }
  }
}

let dir: string;
let sessionPath: string;
let adapter: FakeAdapter;
let store: SessionStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "session-store-delta-"));
  const bucket = join(dir, "sessions", cwdToBucketName(CWD));
  mkdirSync(bucket, { recursive: true });
  sessionPath = join(bucket, "s1.jsonl");
  writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s1", cwd: CWD }) + "\n");
  adapter = new FakeAdapter();
  const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
  store = new SessionStore(factory, catalogFactory, dir);
  // 激活并起进程:start → waitReady → sync,latestSnapshot 落定 {p/a @ high}
  store.setContext(CWD, sessionPath);
  await store.start(CWD, sessionPath);
  adapter.sent = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("setModel 差量执行", () => {
  it("进程已持目标值:跳过 set_model RPC(同值是纯噪声,底座会落 model_change 分隔线)", async () => {
    await store.setModel("p", "a");
    expect(adapter.sent).not.toContain("set_model");
  });

  it("实况有差:发 set_model", async () => {
    await store.setModel("p", "b");
    expect(adapter.sent).toContain("set_model");
  });

  it("快照缺失(实况未知):回落为必发", async () => {
    store.latestSnapshot = null;
    await store.setModel("p", "a");
    expect(adapter.sent).toContain("set_model");
  });
});

describe("setThinkingLevel 差量执行", () => {
  it("进程已持目标档位:跳过 set_thinking_level RPC", async () => {
    await store.setThinkingLevel("high");
    expect(adapter.sent).not.toContain("set_thinking_level");
  });

  it("实况有差:发 set_thinking_level", async () => {
    await store.setThinkingLevel("low");
    expect(adapter.sent).toContain("set_thinking_level");
  });
});

describe("openSession enrich:文件基线补上下文窗口(纯文件,不等 pi 预热)", () => {
  const msgEntry = (id: string, parentId: string | null, message: Record<string, unknown>) => ({
    type: "message", id, parentId, timestamp: "2026-08-06T00:00:00.000Z", message,
  });
  /** 有内容的会话文件:健康锚点 5000,assistant 带 provider/model 证据。 */
  const seedSession = (name: string, extra?: { header?: Record<string, unknown>; modelEvidence?: { provider: string; model: string } | null }): string => {
    const p = join(dir, "sessions", cwdToBucketName(CWD), name);
    const ev = extra?.modelEvidence === null ? {} : { provider: "p", model: "a", ...(extra?.modelEvidence ?? {}) };
    writeFileSync(p, JSON.stringify({ type: "session", id: name, cwd: CWD, ...(extra?.header ?? {}) }) + "\n"
      + JSON.stringify(msgEntry("u1", null, { role: "user", content: "hi" })) + "\n"
      + JSON.stringify(msgEntry("a1", "u1", { role: "assistant", ...ev, content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 4000, output: 500, cacheRead: 0, cacheWrite: 500, totalTokens: 5000, cost: { total: 0.01 } } })) + "\n");
    return p;
  };
  const seedModels = (contextWindow?: number): void => {
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "a", name: "A", ...(contextWindow ? { contextWindow } : {}) }] } } }));
  };

  it("模型证据命中 models.json:contextWindow/percent 填进文件基线", async () => {
    seedModels(10000);
    const p = seedSession("s2.jsonl");
    const detail = await store.openSession(p);
    expect(detail?.stats?.contextUsage?.contextWindow).toBe(10000);
    expect(detail?.stats?.contextUsage?.percent).toBe(50); // 5000/10000;锚点即末条,trailing=0
  });

  it("文件无证据(旧格式):回落头行 custom-my-harness-desktop 模型偏好", async () => {
    seedModels(10000);
    const p = seedSession("s3.jsonl", {
      modelEvidence: null,
      header: { "custom-my-harness-desktop": { model: { provider: "p", modelId: "a", thinkingLevel: "high" } } },
    });
    const detail = await store.openSession(p);
    expect(detail?.stats?.contextUsage?.contextWindow).toBe(10000);
  });

  it("配置里查不到该模型/窗口:保持未知(0),不编数字", async () => {
    seedModels(); // 模型无 contextWindow 字段
    const p = seedSession("s4.jsonl");
    const detail = await store.openSession(p);
    expect(detail?.stats?.contextUsage?.contextWindow).toBe(0);
  });
});

describe("配置依赖失效重建(docs/design/models-config-reload.md)", () => {
  /** 自建 store:factory 计数 spawn 次数(models.json/settings.json 变更 → 复用前校验过期 → 重建)。 */
  function newStore(): { s: SessionStore; spawnCount: () => number } {
    let created = 0;
    const factory: BackendFactory = { create: (opts) => { created++; return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }); } };
    const s = new SessionStore(factory, catalogFactory, dir);
    s.setContext(CWD, sessionPath);
    return { s, spawnCount: () => created };
  }

  it("进程活且配置未变:复用,不重建", async () => {
    const { s, spawnCount } = newStore();
    await s.start(CWD, sessionPath);
    adapter.sent = [];
    await s.setModel("p", "a"); // ensureForSend 校验未过期 → 复用 → 差量跳过 set_model
    expect(spawnCount()).toBe(1);
    expect(adapter.sent).not.toContain("set_model");
  });

  it("models.json 变更:停旧进程重建", async () => {
    const { s, spawnCount } = newStore();
    await s.start(CWD, sessionPath);
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
    utimesSync(modelsPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    adapter.sent = [];
    await s.setModel("p", "a"); // 快照过期 → stop 旧进程 → 重建 spawn 读新配置
    expect(spawnCount()).toBe(2);
  });

  it("settings.json 变更:停旧进程重建", async () => {
    const { s, spawnCount } = newStore();
    await s.start(CWD, sessionPath);
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "{}");
    utimesSync(settingsPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    adapter.sent = [];
    await s.setModel("p", "a");
    expect(spawnCount()).toBe(2);
  });

  it("配置文件删除(存在性变化):停旧进程重建", async () => {
    const { s, spawnCount } = newStore();
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, "{}"); // spawn 前存在 → 快照记 mtime
    await s.start(CWD, sessionPath);
    rmSync(modelsPath); // 删除 → 存在性变化
    adapter.sent = [];
    await s.setModel("p", "a");
    expect(spawnCount()).toBe(2);
  });
});

describe("abort 双保险与强杀兜底", () => {
  it("先发 abort_bash 再发 abort(executeBash 路径兜底)", async () => {
    await store.abort();
    const cmds = adapter.sent.filter((t) => t === "abort_bash" || t === "abort");
    expect(cmds).toEqual(["abort_bash", "abort"]);
  });

  it("abort 命令失败时强杀进程兜底", async () => {
    const originalSend = adapter.send.bind(adapter);
    adapter.send = async (command: RpcCommand) => {
      if (command.type === "abort") throw new Error("timeout");
      return originalSend(command);
    };
    const stopSpy = vi.spyOn(adapter, "stop");
    await store.abort(); // 不抛错:abort 失败被吞,走强杀兜底
    expect(stopSpy).toHaveBeenCalled();
  });

  it("abort 正常返回时不强杀进程", async () => {
    const stopSpy = vi.spyOn(adapter, "stop");
    await store.abort();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("abort_bash 失败不影响 abort 发出", async () => {
    const originalSend = adapter.send.bind(adapter);
    adapter.send = async (command: RpcCommand) => {
      if (command.type === "abort_bash") {
        adapter.sent.push("abort_bash"); // 命令已发出,仅响应失败
        throw new Error("no bash");
      }
      return originalSend(command);
    };
    await store.abort();
    const cmds = adapter.sent.filter((t) => t === "abort_bash" || t === "abort");
    expect(cmds).toEqual(["abort_bash", "abort"]);
  });
});

/** 记录调用序列的假后端(测 switchKernel 五步)。 */
class MockBackend {
  alive = true;
  calls: string[] = [];
  async start(): Promise<void> { this.calls.push("start"); this.alive = true; }
  async stop(): Promise<void> { this.calls.push("stop"); this.alive = false; }
  onEvent(): () => void { return () => {}; }
  async fork(): Promise<string> { return "f"; }
  async getTree(): Promise<LineageTree> { return { rootId: "", lineages: [] }; }
  async getEntries(): Promise<NeutralMessage[]> { this.calls.push("getEntries"); return [{ role: "user", content: "hi" }]; }
  async bookmark(): Promise<Anchor> { return { lineageId: "", entryId: "" }; }
  async resume(): Promise<string> { return "r"; }
  async deleteBookmark(): Promise<void> {}
  async sendMessage(): Promise<void> {}
  async abort(): Promise<void> { this.calls.push("abort"); }
  async setModel(): Promise<void> {}
  async seed(): Promise<string> { this.calls.push("seed"); return "dsh-s1"; }
}

describe("switchKernel 五步切换", () => {
  it("pi → dsh:新后端 start + seed,旧后端 abort + stop", async () => {
    const mock = new MockBackend();
    const factory: BackendFactory = {
      create: (opts) => opts.kernel === "dsh"
        ? mock as unknown as BaseBackend
        : new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
    };
    const s = new SessionStore(factory, catalogFactory, dir);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    adapter.sent = [];

    await s.switchKernel("dsh");

    // 旧 pi 后端:abort 走了 RPC;新 dsh 后端:start 后 seed
    expect(adapter.sent).toContain("abort");
    expect(mock.calls).toEqual(["start", "seed"]);
    // 旧 pi 进程已停
    expect(adapter.alive).toBe(false);
  });
});
