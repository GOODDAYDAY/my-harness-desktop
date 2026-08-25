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
import type { BaseBackend, LineageTree, Anchor, BoundaryRef, SessionCatalogFactory, KernelModelSource } from "../../domain/backend";
import type { NeutralMessage } from "../../domain/events/session-state";
import type { NeutralSession } from "../../domain/session-neutral";
import { ModelCatalog } from "../models/model-catalog";
import { PiModelSource } from "../../../client/pi/pi-model-source";
import { ModelsStore } from "../../../client/pi/models-store";
import { SessionBindingStore } from "./session-binding-store";
import type { KernelWarmup } from "../../domain/kernel-warmup";

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
  // models.json 让 ModelCatalog 有 p/a、p/b 模型(setModel 反查依赖;见 kernel-follows-model.md §2.3)
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "a" }, { id: "b" }] } } }));
  adapter = new FakeAdapter();
  const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
  store = new SessionStore(factory, catalogFactory, dir, undefined, undefined, undefined, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
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
    const modelCatalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]);
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, undefined, modelCatalog);
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
    writeFileSync(modelsPath, JSON.stringify({ providers: { p: { models: [{ id: "a", name: "A2" }] } } }));
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
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "{}"); // spawn 前存在 → 快照记 mtime
    await s.start(CWD, sessionPath);
    rmSync(settingsPath); // 删除 → 存在性变化
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
  capabilities = {};
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
  async setModel(p?: string, m?: string): Promise<void> { this.calls.push(`setModel:${p}/${m}`); }
  async seed(): Promise<string> { this.calls.push("seed"); return "dsh-s1"; }
}

// 暂缓切换(kernel-follows-model.md §3.2):入口 gate 挡住七步编排,以下用例未来放开切换时重新启用。
describe.skip("switchKernel 五步切换", () => {
  it("pi → dsh(空会话):新后端 start、跳过 seed,旧后端 abort + stop", async () => {
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

    // 旧 pi 后端:abort 走了 RPC;新 dsh 后端:start(空会话跳过 seed)
    expect(adapter.sent).toContain("abort");
    expect(mock.calls).toEqual(["start"]);
    // 旧 pi 进程已停
    expect(adapter.alive).toBe(false);
  });
});

describe("setModel 跨内核路由(中间转换层)", () => {
  it("模型属于 dsh 而当前是 pi(有历史,发过消息):暂缓切换,显式降级抛错,不把 dsh 模型发到 pi", async () => {
    const dshSource: KernelModelSource = {
      listModels: () => [{ kernel: "dsh", provider: "us-new", id: "bifrost/tencent/deepseek-v4-pro", name: "deepseek-v4-pro" }],
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const mock = new MockBackend();
    const factory: BackendFactory = {
      create: (opts) => opts.kernel === "dsh"
        ? mock as unknown as BaseBackend
        : new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, undefined, catalog);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    await s.prompt("hi"); // 发一条消息 → touched=true,有历史
    adapter.sent = [];
    mock.calls = [];

    // 暂缓切换(kernel-follows-model.md §2.3):有历史 pi 进程选 dsh 模型 → 显式降级,不走 switchKernel
    await expect(s.setModel("us-new", "bifrost/tencent/deepseek-v4-pro")).rejects.toThrow("跨内核切换后续支持");

    // 关键断言:pi 后端没有收到 set_model(dsh 模型 id 绝不落到 pi),也没有 abort/stop 切换动作
    expect(adapter.sent).not.toContain("set_model");
    expect(adapter.sent).not.toContain("abort");
    expect(adapter.alive).toBe(true);
    expect(mock.calls).toEqual([]);
  });
});

// 暂缓切换:同上,放开时重新启用。
describe.skip("switchKernel 失效回退 + 预 seed(§4.5/§8)", () => {
  it("回切 pi 时绑定失效(空会话)→ 经 factory.seed 重新投影,不静默开空会话", async () => {
    const dshMock = new MockBackend();
    const piSeeds: NeutralSession[] = [];
    const bindingDir = mkdtempSync(join(tmpdir(), "session-store-binding-"));
    const bindingStore = new SessionBindingStore(bindingDir);
    const factory: BackendFactory = {
      create: (opts) => opts.kernel === "dsh"
        ? dshMock as unknown as BaseBackend
        : new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
      seed: async (session, { kernel }) => {
        // 契约:返回 string = 预 seed(pi);返回 null = 需 start 后 seed(dsh)。
        if (kernel === "dsh") return null;
        piSeeds.push(session);
        return "/tmp/seeded-pi.jsonl";
      },
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, bindingStore);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath); // bindingStore.put((ns, pi) → sessionPath);sessionPath 是空会话(仅头行)
    adapter.sent = [];
    dshMock.calls = [];

    await s.switchKernel("dsh"); // 建立 dsh 绑定
    await s.switchKernel("pi");  // 回切:pi 绑定 sessionPath 是空会话 → isBindingValid false → re-seed

    // 走了 factory.seed 重新投影(而非直接续接空会话)
    expect(piSeeds).toHaveLength(1);
    expect(piSeeds[0].neutralSessionId).toBeTruthy();
    rmSync(bindingDir, { recursive: true, force: true });
  });
});

describe("内核跟随模型(清理默认 pi + 暂缓切换,kernel-follows-model.md)", () => {
  it("switchKernel gate:直接调用抛「跨内核切换暂未启用」", async () => {
    await expect(store.switchKernel("dsh")).rejects.toThrow("跨内核切换暂未启用");
  });

  it("setModel 查不到模型:抛「模型不在清单」,不回落 pi", async () => {
    await expect(store.setModel("x", "y")).rejects.toThrow("模型不在清单: x/y");
  });

  it("setModel 空会话选 dsh 模型:直接以 dsh 起,不经过 switchKernel", async () => {
    const dshSource: KernelModelSource = {
      listModels: () => [{ kernel: "dsh", provider: "us-new", id: "dsh-model", name: "dsh-model" }],
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const createdKernels: string[] = [];
    const factory: BackendFactory = {
      create: (opts) => { createdKernels.push(opts.kernel); return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }); },
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, undefined, catalog);
    s.setContext(CWD, null); // 空会话,无活跃进程
    await s.setModel("us-new", "dsh-model");
    // 空会话选 dsh 模型 = 「选择」,以目标内核直接起,不是 switchKernel 七步
    expect(createdKernels).toEqual(["dsh"]);
  });

  it("setModel 预热 pi(未发消息)后选 dsh 模型:并存激活 dsh,pi 槽位保留,不是切换", async () => {
    const dshSource: KernelModelSource = {
      listModels: () => [{ kernel: "dsh", provider: "us-new", id: "dsh-model", name: "dsh-model" }],
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const createdKernels: string[] = [];
    const factory: BackendFactory = {
      create: (opts) => { createdKernels.push(opts.kernel); return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }); },
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, undefined, catalog);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath); // 预热 pi(warmup 语义),touched=false
    await s.setModel("us-new", "dsh-model");
    // 预热 pi 未发过消息 → 选 dsh 是「选择」,pi/dsh 槽位并存(都 alive),不抛「切换后续支持」
    expect(createdKernels).toEqual(["pi", "dsh"]);
  });

  it("start 读回:bindingStore 有 dsh 绑定 → 以 dsh 起(重开历史 dsh 会话不落 pi)", async () => {
    const bindingDir = mkdtempSync(join(tmpdir(), "session-store-kernel-"));
    const bindingStore = new SessionBindingStore(bindingDir);
    const ns = "test-ns";
    bindingStore.put({ kernel: "dsh", neutralSessionId: ns, kernelPrivateId: "dsh-session-1", boundAt: new Date().toISOString() });
    // 会话头写 neutralSessionId,让 start 的 resolveNeutralSessionId 命中后查 bindingStore
    writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s1", cwd: CWD, "custom-my-harness-desktop": { neutralSessionId: ns } }) + "\n");
    const createdKernels: string[] = [];
    const factory: BackendFactory = {
      create: (opts) => { createdKernels.push(opts.kernel); return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }); },
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, bindingStore);
    await s.start(CWD, sessionPath); // 不传 kernel → 读回归属
    expect(createdKernels).toEqual(["dsh"]);
    rmSync(bindingDir, { recursive: true, force: true });
  });

  it("warmup 遍历注册的 warmup 实现(未注册的内核不 warmup)", async () => {
    const createdKernels: string[] = [];
    const factory: BackendFactory = {
      create: (opts) => { createdKernels.push(opts.kernel); return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }); },
    };
    // 只注册 pi warmup(dsh 未注册 → 不预热),验证「支持 warmup / 不支持 warmup」两种
    const warmups: KernelWarmup[] = [{ kernel: "pi", prepareSessionId: () => sessionPath }];
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, undefined, undefined, warmups);
    s.setContext(CWD, sessionPath);
    s.warmup(CWD, sessionPath);
    await vi.waitFor(() => expect(createdKernels).toEqual(["pi"]));
  });

  it("warmup 非文件内核(dsh)挂 pending 会话 key(new:cwd),不挂 pi 的 warmPath(根因:会话未启动)", async () => {
    const factory: BackendFactory = {
      create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
    };
    // 注册 pi + dsh 两个 warmup:pi 有 prepareSessionId(预生成文件路径),dsh 惰性(无文件)
    const warmups: KernelWarmup[] = [
      { kernel: "pi", prepareSessionId: () => sessionPath },
      { kernel: "dsh" },
    ];
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, undefined, undefined, warmups);
    s.setContext(CWD, null); // 新会话:activeProcKey = new:${CWD}
    s.warmup(CWD, null);
    await vi.waitFor(() => {
      // 两个内核都预热完成后,procs 应有两个 key:pi 在文件路径(sessionPath),dsh 在 new:cwd。
      // 若 dsh 错挂 sessionPath,startNewChat 的 setContext 重置 key 后 prompt 查不到 →「会话未启动」。
      expect(s.getRunningSessionKeys().sort()).toEqual([`new:${CWD}`, sessionPath].sort());
    });
  });

  it("没有 warmup(空列表)也能发起:选模型按需起进程 + 发消息(warmup 只是加速项)", async () => {
    const createdKernels: string[] = [];
    const factory: BackendFactory = {
      create: (opts) => { createdKernels.push(opts.kernel); return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }); },
    };
    const dshSource: KernelModelSource = {
      listModels: () => [{ kernel: "dsh", provider: "us-new", id: "dsh-model", name: "dsh-model" }],
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    // 不传 kernelWarmups → 空列表 = 完全不预热
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, undefined, catalog);
    s.setContext(CWD, null);
    s.warmup(CWD, null); // 空列表:warmup 只做会话水合,不预热任何进程
    await s.setModel("us-new", "dsh-model"); // 没有预热,选 dsh 模型按需起进程
    expect(createdKernels).toEqual(["dsh"]);
    await s.prompt("hi"); // 能正常发消息
    expect(adapter.sent).toContain("prompt");
  });
});

describe("prompt 强度对齐只对支持运行时切档的内核生效(§atomic-send 修订)", () => {
  /** 假 dsh 后端:capabilities 无 pi 扩展面,setThinkingLevel 抛缺面默认。
   *  用于验证 prompt 发送路径对缺面内核「跳过」而非「抛错」——显式切档仍走契约抛错。 */
  class FakeDshBackend {
    alive = true;
    capabilities = {}; // 无 pi 扩展面(§7.6 缺面)
    calls: string[] = [];
    async start(): Promise<void> { this.alive = true; }
    async stop(): Promise<void> { this.alive = false; }
    onEvent(): () => void { return () => {}; }
    async sendMessage(): Promise<void> { this.calls.push("sendMessage"); }
    async setModel(): Promise<void> { this.calls.push("setModel"); }
    async setThinkingLevel(): Promise<void> {
      this.calls.push("setThinkingLevel");
      throw new Error("当前内核不支持思考强度切换");
    }
    async setSessionName(): Promise<void> { this.calls.push("setSessionName"); }
    async seed(): Promise<string> { return "dsh-s1"; }
    async fork(): Promise<unknown> { return { lineageId: "f", sessionReplaced: false }; }
    async getTree(): Promise<LineageTree> { return { rootId: "", lineages: [] }; }
    async getEntries(): Promise<NeutralMessage[]> { return []; }
    async bookmark(): Promise<Anchor> { return { lineageId: "", entryId: "" }; }
    async resume(): Promise<string> { return "r"; }
    async deleteBookmark(): Promise<void> {}
    async abort(): Promise<void> {}
  }

  it("dsh(无 capabilities.pi)prompt 带 thinkingLevel:跳过 setThinkingLevel,不抛错、正常发送", async () => {
    const dsh = new FakeDshBackend();
    const createdKernels: string[] = [];
    const factory: BackendFactory = {
      create: (opts) => { createdKernels.push(opts.kernel); return dsh as unknown as BaseBackend; },
    };
    const s = new SessionStore(factory, catalogFactory, dir);
    s.setContext(CWD, null); // 新会话
    // 根因回归:composer 会给 pending 盖默认档位("high"),dsh 发送必须不被它打断。
    await s.prompt("hi", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "high", kernel: "dsh" });
    expect(createdKernels).toEqual(["dsh"]);
    expect(dsh.calls).toContain("sendMessage");
    expect(dsh.calls).not.toContain("setThinkingLevel");
  });

  it("pi(有 capabilities.pi)prompt 带 thinkingLevel:仍走 setThinkingLevel,不回归", async () => {
    // store(pi 后端 + FakeAdapter)已由 beforeEach 起好,latestSnapshot = {p/a @ high}。
    await store.prompt("hi", undefined, undefined, { provider: "p", modelId: "a", thinkingLevel: "low" });
    expect(adapter.sent).toContain("set_thinking_level"); // pi 路径不被能力探测误伤
    expect(adapter.sent).toContain("prompt");
  });
});
