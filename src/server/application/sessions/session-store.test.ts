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
import { PiBackend } from "../../kernel/pi/backend/pi-backend";
import { PiSessionCatalog } from "../../kernel/pi/backend/pi-catalog";
import { cwdToBucketName } from "@my-harness-desktop/shared";
import type { RpcAdapter } from "../../kernel/pi/backend/rpc-adapter";
import type { RpcCommand } from "../../kernel/pi/protocol/rpc-types";
import type { BaseBackend, LineageTree, Anchor, BoundaryRef, SessionCatalogFactory, KernelModelSource } from "@my-harness-desktop/shared";
import type { NeutralMessage } from "@my-harness-desktop/shared";
import type { NeutralSession } from "@my-harness-desktop/shared";
import { ModelCatalog } from "../models/model-catalog";
import { PiModelSource } from "../../kernel/pi/model/pi-model-source";
import { ModelsStore } from "../../kernel/pi/model/models-store";
import { NeutralSessionStore } from "./neutral-session-store";
import { emptyNeutralSession } from "@my-harness-desktop/shared";

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
  writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s1", cwd: CWD, "custom-my-harness-desktop": { kernel: "pi" } }) + "\n");
  // models.json 让 ModelCatalog 有 p/a、p/b 模型(setModel 反查依赖;见 kernel-follows-model.md §2.3)
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "a" }, { id: "b" }] } } }));
  adapter = new FakeAdapter();
  const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
  store = new SessionStore(factory, catalogFactory, dir, undefined, undefined, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
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
    await store.setModel("p", "a", "pi");
    expect(adapter.sent).not.toContain("set_model");
  });

  it("实况有差:发 set_model", async () => {
    await store.setModel("p", "b", "pi");
    expect(adapter.sent).toContain("set_model");
  });

  it("快照缺失(实况未知):回落为必发", async () => {
    store.latestSnapshot = null;
    await store.setModel("p", "a", "pi");
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


describe("配置依赖失效重建(docs/design/models-config-reload.md)", () => {
  /** 自建 store:factory 计数 spawn 次数(models.json/settings.json 变更 → 复用前校验过期 → 重建)。 */
  function newStore(): { s: SessionStore; spawnCount: () => number } {
    let created = 0;
    const factory: BackendFactory = { create: (opts) => { created++; return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }); } };
    const modelCatalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]);
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, modelCatalog);
    s.setContext(CWD, sessionPath);
    return { s, spawnCount: () => created };
  }

  it("进程活且配置未变:复用,不重建", async () => {
    const { s, spawnCount } = newStore();
    await s.start(CWD, sessionPath);
    adapter.sent = [];
    await s.setModel("p", "a", "pi"); // ensureForSend 校验未过期 → 复用 → 差量跳过 set_model
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
    await s.setModel("p", "a", "pi"); // 快照过期 → stop 旧进程 → 重建 spawn 读新配置
    expect(spawnCount()).toBe(2);
  });

  it("settings.json 变更:停旧进程重建", async () => {
    const { s, spawnCount } = newStore();
    await s.start(CWD, sessionPath);
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "{}");
    utimesSync(settingsPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    adapter.sent = [];
    await s.setModel("p", "a", "pi");
    expect(spawnCount()).toBe(2);
  });

  it("配置文件删除(存在性变化):停旧进程重建", async () => {
    const { s, spawnCount } = newStore();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "{}"); // spawn 前存在 → 快照记 mtime
    await s.start(CWD, sessionPath);
    rmSync(settingsPath); // 删除 → 存在性变化
    adapter.sent = [];
    await s.setModel("p", "a", "pi");
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
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, catalog);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    await s.prompt("hi"); // 发一条消息 → touched=true,有历史
    adapter.sent = [];
    mock.calls = [];

    // 暂缓切换(kernel-follows-model.md §2.3):有历史 pi 进程选 dsh 模型 → 显式降级,不走 switchKernel
    await expect(s.setModel("us-new", "bifrost/tencent/deepseek-v4-pro", "dsh")).rejects.toThrow("跨内核切换后续支持");

    // 关键断言:pi 后端没有收到 set_model(dsh 模型 id 绝不落到 pi),也没有 abort/stop 切换动作
    expect(adapter.sent).not.toContain("set_model");
    expect(adapter.sent).not.toContain("abort");
    expect(adapter.alive).toBe(true);
    expect(mock.calls).toEqual([]);
  });
});


describe("内核跟随模型(清理默认 pi + 暂缓切换,kernel-follows-model.md)", () => {
  it("switchKernel gate:直接调用抛「跨内核切换暂未启用」", async () => {
    await expect(store.switchKernel("dsh")).rejects.toThrow("跨内核切换暂未启用");
  });

  it("setModel 查不到模型:抛「模型不在清单」,不回落 pi", async () => {
    await expect(store.setModel("x", "y", "pi")).rejects.toThrow("模型不在清单: pi/x/y");
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
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, catalog);
    s.setContext(CWD, null); // 空会话,无活跃进程
    await s.setModel("us-new", "dsh-model", "dsh");
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
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, catalog);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath); // 预热 pi(warmup 语义),touched=false
    await s.setModel("us-new", "dsh-model", "dsh");
    // 预热 pi 未发过消息 → 选 dsh 是「选择」,pi/dsh 槽位并存(都 alive),不抛「切换后续支持」
    expect(createdKernels).toEqual(["pi", "dsh"]);
  });


  it("没有预热也发起:选模型按需起进程 + 发消息(进程只在选模型后起)", async () => {
    const createdKernels: string[] = [];
    const factory: BackendFactory = {
      create: (opts) => { createdKernels.push(opts.kernel); return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }); },
    };
    const dshSource: KernelModelSource = {
      listModels: () => [{ kernel: "dsh", provider: "us-new", id: "dsh-model", name: "dsh-model" }],
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, catalog);
    s.setContext(CWD, null);
    // setContext 后不起任何进程(内核=模型派生量,选模前无内核)——抢跑预热已移除
    expect(createdKernels).toEqual([]);
    await s.setModel("us-new", "dsh-model", "dsh"); // 选 dsh 模型 → 按需只起 dsh
    expect(createdKernels).toEqual(["dsh"]);
    await s.prompt("hi"); // 能正常发消息
    expect(adapter.sent).toContain("prompt");
  });
});

describe("内核路由回归(选 dsh 不得调度到 pi;会话归属持久)", () => {
  /** dsh 假后端:记录 create 次数,无 pi 扩展面。 */
  function makeDshFactory(created: string[], backends: { sessionId?: string }[]): BackendFactory {
    return {
      create: (opts) => {
        created.push(opts.kernel);
        const b = new FakeDshRoutingBackend(opts.neutralSessionId);
        backends.push(b as unknown as { sessionId?: string });
        return b as unknown as BaseBackend;
      },
    };
  }
  class FakeDshRoutingBackend {
    alive = false;
    capabilities = {};
    calls: string[] = [];
    constructor(public neutralSessionId?: string) {}
    get sessionId(): string | undefined { return undefined; }
    async start(): Promise<void> { this.alive = true; this.calls.push("start"); }
    async stop(): Promise<void> { this.alive = false; }
    onEvent(): () => void { return () => {}; }
    async sendMessage(): Promise<void> { this.calls.push("sendMessage"); }
    async setModel(): Promise<void> { this.calls.push("setModel"); }
    async setSessionName(): Promise<void> { this.calls.push("setSessionName"); }
    seedLineageLength: number | null = null;
    async seed(lineage?: unknown[]): Promise<string> { this.calls.push("seed"); this.seedLineageLength = lineage?.length ?? 0; return "seeded"; }
    async fork(): Promise<unknown> { return { lineageId: "f", sessionReplaced: false }; }
    async getTree(): Promise<LineageTree> { return { rootId: "", lineages: [] }; }
    async getEntries(): Promise<NeutralMessage[]> { return []; }
    async bookmark(): Promise<Anchor> { return { lineageId: "", entryId: "" }; }
    async deleteBookmark(): Promise<void> {}
    async abort(): Promise<void> {}
  }
  const dshSource: KernelModelSource = {
    listModels: () => [{ kernel: "dsh", provider: "us-new", id: "dsh-model", name: "dsh-model" }],
  };

  it("新会话选 dsh 模型发送:只起 dsh 进程,中立头落 kernel=dsh,绝不抢跑起 pi", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "route-neutral-")));
    const created: string[] = [];
    const backends: { sessionId?: string }[] = [];
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const s = new SessionStore(makeDshFactory(created, backends), catalogFactory, dir, undefined, neutralStore, catalog);
    s.setContext(CWD, null);
    await s.prompt("你好", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    // 只创建过一个进程,且是 dsh(pi 从未被抢跑起)
    expect(created).toEqual(["dsh"]);
    // 中立层会话归属 = dsh(真相源持久,重开按头读回)
    const sessions = neutralStore.listByCwd(CWD);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].header.kernel).toBe("dsh");
    // 模型域持久(重开/第二发的兜底来源)
    const custom = sessions[0].header.custom as Record<string, unknown>;
    expect(custom).toBeTruthy();
  });

  it("dsh 会话第二发(不带偏好):按中立头读回模型域,续用同一会话不漂移", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "route-neutral-")));
    const created: string[] = [];
    const backends: { sessionId?: string }[] = [];
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const s = new SessionStore(makeDshFactory(created, backends), catalogFactory, dir, undefined, neutralStore, catalog);
    s.setContext(CWD, null);
    await s.prompt("第一发", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    // 第二发不带偏好(重开历史会话的形态):服务端兜底读中立头,仍走 dsh,不新起进程
    await s.prompt("第二发");
    expect(created).toEqual(["dsh"]); // 复用同一进程,没有二次创建
    expect(s.getRunningSessionKeys()).toHaveLength(1);
  });

  it("dsh 会话:自动命名只在首发跑一次,第二发不再重命名(「每次输入都更新会话名」回归)", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "route-neutral-")));
    const created: string[] = [];
    const backends: { sessionId?: string }[] = [];
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const s = new SessionStore(makeDshFactory(created, backends), catalogFactory, dir, undefined, neutralStore, catalog);
    s.setContext(CWD, null);
    await s.prompt("第一发", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    const backend = backends[0] as unknown as { calls: string[] };
    // 首发:自动命名一次(写中立头 + 一次内核 rename + 一条改名分隔线)
    expect(backend.calls.filter((c) => c === "setSessionName")).toHaveLength(1);
    // 第二发:中立层已记名 → 不再重命名(旧判据读 latestSnapshot——dsh 恒 null → 每发必改名)
    await s.prompt("第二发", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    expect(backend.calls.filter((c) => c === "setSessionName")).toHaveLength(1);
  });

  it("重开历史 dsh 会话续发:中立层有历史 → 发送前 seed 投影回填(session-single-source §4.4,替代旧的 continue 重放)", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "route-neutral-")));
    const created: string[] = [];
    const backends: { sessionId?: string }[] = [];
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const s = new SessionStore(makeDshFactory(created, backends), catalogFactory, dir, undefined, neutralStore, catalog);
    s.setContext(CWD, null);
    // 第一发:新会话(中立层空)→ 不 seed 不 continue。
    await s.prompt("第一发", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    const backend = backends[0] as unknown as { calls: string[] };
    expect(backend.calls).not.toContain("continue");
    expect(backend.calls).not.toContain("seed"); // 空投影不 seed

    // 同进程第二发:进程已有内容(物化标记已对齐)→ 不重复 seed。
    backend.calls.length = 0;
    await s.prompt("第二发", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    expect(backend.calls).not.toContain("seed");
    expect(backend.calls).toContain("sendMessage");

    // 真重开形态:新 SessionStore + 新进程,中立层带历史 → 首发前 seed 投影,且在 sendMessage 之前。
    const ns = neutralStore.listByCwd(CWD)[0].neutralSessionId;
    const created2: string[] = [];
    const backends2: { sessionId?: string }[] = [];
    const s2 = new SessionStore(makeDshFactory(created2, backends2), catalogFactory, dir, undefined, neutralStore, catalog);
    s2.setContext(CWD, ns); // dsh 投影地址 = 裸 ns(中立主键反查会话归属)
    await s2.prompt("重开后续聊", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    const reopened = backends2[0] as unknown as { calls: string[]; seedLineageLength: number | null };
    expect(reopened.calls).toContain("seed");
    expect(reopened.calls.indexOf("seed")).toBeLessThan(reopened.calls.indexOf("sendMessage"));
    expect(reopened.calls).not.toContain("continue"); // continue 重放补面已删
    expect(reopened.seedLineageLength).toBeGreaterThan(0); // 中立层历史灌进内核
  });

  it("dsh 第二发:进程模型未变 → 不重发 session/setModel(无快照面内核的已生效真相源 = 起进程模型)", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "route-neutral-")));
    const created: string[] = [];
    const backends: { sessionId?: string }[] = [];
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const s = new SessionStore(makeDshFactory(created, backends), catalogFactory, dir, undefined, neutralStore, catalog);
    s.setContext(CWD, null);
    await s.prompt("第一发", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    const calls = (backends[0] as unknown as { calls: string[] }).calls;
    calls.length = 0;
    // 第二发带回头偏好(与中立头同模型):旧实现因 latestSnapshot 恒 null 判「未生效」重发
    // setModel——dsh 该 RPC 在部分运行时是坏面,第二发每次都被打断(根因回归位)。
    await s.prompt("第二发", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    expect(calls).toContain("sendMessage");
    expect(calls).not.toContain("setModel");
  });

  it("dsh 的 session/setModel 是坏面(一调就抛)也不挡住第二发:续发照常落同一会话", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "route-neutral-")));
    const created: string[] = [];
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    // 与 makeDshFactory 同款,但 setModel 模拟坏面(真实 dsh 报
    // "cannot get property sessions without inject")。
    const factory: BackendFactory = {
      create: (opts) => {
        created.push(opts.kernel);
        const b = new FakeDshRoutingBackend(opts.neutralSessionId);
        b.setModel = async () => { throw new Error('cannot get property "sessions" without inject'); };
        return b as unknown as BaseBackend;
      },
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, catalog);
    s.setContext(CWD, null);
    await s.prompt("第一发", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    // 旧实现:第二发的 prompt 编排先走 setModel → 坏面抛错 → 整条发送失败。
    // 修复后:进程模型 = 目标模型 → 判已生效跳过坏面 → 第二发成功。
    await expect(s.prompt("第二发", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" }))
      .resolves.toBeUndefined();
    const sessions = neutralStore.listByCwd(CWD);
    expect(sessions).toHaveLength(1); // 同一会话续发,没漂去新会话
    expect(sessions[0].lineages.flatMap((l) => l.entries).filter((e) => e.message.role === "user")).toHaveLength(2);
  });

  it("⌘N 新会话后再发:不复用旧会话的 dsh 进程(消息不串会话)", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "route-neutral-")));
    const created: string[] = [];
    const backends: { sessionId?: string }[] = [];
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const s = new SessionStore(makeDshFactory(created, backends), catalogFactory, dir, undefined, neutralStore, catalog);
    s.setContext(CWD, null);
    await s.prompt("旧会话消息", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    // ⌘N:renderer 清上下文 = setContext(cwd, null)
    s.setContext(CWD, null);
    await s.prompt("新会话消息", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    // 两条消息属于两个不同的中立会话(新会话不复用旧会话的进程/主键)
    const sessions = neutralStore.listByCwd(CWD).sort((a, b) => a.header.createdAt.localeCompare(b.header.createdAt));
    expect(sessions.length).toBe(2);
    for (const sess of sessions) {
      expect(sess.header.kernel).toBe("dsh");
      // 每个会话恰好一条用户消息(分隔线等元条目随双落点入中立层是预期,不按总条目数断言)
      const userEntries = sess.lineages.flatMap((l) => l.entries).filter((e) => e.message.role === "user");
      expect(userEntries).toHaveLength(1);
    }
    expect(created).toEqual(["dsh", "dsh"]);
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
    const dshSource: KernelModelSource = {
      listModels: () => [{ kernel: "dsh", provider: "us-new", id: "dsh-model", name: "dsh-model" }],
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, new ModelCatalog([dshSource]));
    s.setContext(CWD, null); // 新会话
    // 根因回归:composer 会给 pending 盖默认档位("high"),dsh 发送必须不被它打断。
    await s.prompt("hi", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "high", kernel: "dsh" });
    expect(createdKernels).toEqual(["dsh"]);
    expect(dsh.calls).toContain("sendMessage");
    expect(dsh.calls).not.toContain("setThinkingLevel");
  });

  it("pi(有 capabilities.pi)prompt 带 thinkingLevel:仍走 setThinkingLevel,不回归", async () => {
    // store(pi 后端 + FakeAdapter)已由 beforeEach 起好,latestSnapshot = {p/a @ high}。
    await store.prompt("hi", undefined, undefined, { provider: "p", modelId: "a", thinkingLevel: "low", kernel: "pi" });
    expect(adapter.sent).toContain("set_thinking_level"); // pi 路径不被能力探测误伤
    expect(adapter.sent).toContain("prompt");
  });
});

describe("归档/置顶:中立层真相源不被内核投影失败阻断", () => {
  /** 带中立层的 store,预置一条有 name/pinned/custom 的中立会话;sessionPath 用派生路径
   *  但故意不落盘——复现 pi 旧命名 `<stamp>_<id>.jsonl` 与派生 `<ns>.jsonl` 不匹配时
   *  内核投影必抛「会话文件不存在」的场景,断言中立层写仍生效且不丢已有字段。 */
  function newNeutralStore(): { s: SessionStore; neutralStore: NeutralSessionStore; ns: string; sessionPath: string } {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "session-store-neutral-")));
    const ns = "ns-archive";
    neutralStore.put(emptyNeutralSession(ns, {
      kernel: "pi",
      cwd: CWD,
      createdAt: "2026-08-27T00:00:00.000Z",
      name: "我的会话",
      pinned: true,
      custom: { subagent: { parent_id: "main" } },
    }));
    // 派生路径 = <bucket>/<ns>.jsonl,不写盘 → 内核投影 existsSync 失败必抛。
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    s.setContext(CWD, sessionPath);
    return { s, neutralStore, ns, sessionPath };
  }

  it("归档:内核投影失败仍落中立层 archived=true,且 name/pinned/custom 不丢", async () => {
    const { s, neutralStore, ns, sessionPath } = newNeutralStore();
    await s.updateHeader(sessionPath, { archived: true });
    const h = neutralStore.get(ns)?.header;
    expect(h?.archived).toBe(true);
    expect(h?.name).toBe("我的会话");
    expect(h?.pinned).toBe(true);
    expect(h?.custom).toEqual({ subagent: { parent_id: "main" } });
  });

  it("取消归档(archived=false):置回未归档但不抹 name/pinned", async () => {
    const { s, neutralStore, ns, sessionPath } = newNeutralStore();
    await s.updateHeader(sessionPath, { archived: true });
    await s.updateHeader(sessionPath, { archived: false });
    const h = neutralStore.get(ns)?.header;
    expect(Boolean(h?.archived)).toBe(false);
    expect(h?.name).toBe("我的会话");
    expect(h?.pinned).toBe(true);
  });

  it("置顶(pinned=false):只取消置顶,不抹 name/custom", async () => {
    const { s, neutralStore, ns, sessionPath } = newNeutralStore();
    await s.updateHeader(sessionPath, { pinned: false });
    const h = neutralStore.get(ns)?.header;
    expect(Boolean(h?.pinned)).toBe(false);
    expect(h?.name).toBe("我的会话");
    expect(h?.custom).toEqual({ subagent: { parent_id: "main" } });
  });

  it("会话注解:落中立层条目(自定义 role,不进对话角色),openSession 消息流可读回", async () => {
    const { s, neutralStore, ns, sessionPath } = newNeutralStore();
    await s.annotate(sessionPath, "goal_note", '{"action":"pause"}');
    const session = neutralStore.get(ns);
    const notes = session?.lineages.flatMap((l) => l.entries).filter((e) => e.message.role === "goal_note");
    expect(notes).toHaveLength(1);
    expect(notes?.[0].message.content).toBe('{"action":"pause"}');
    // 注解条目随 openSession 进消息流(messageRenderers 槽按 role 认领渲染)
    const detail = await s.openSession(ns);
    expect(detail?.messages.some((m) => m.role === "goal_note")).toBe(true);
  });
});

describe("rawFilePaths(打开原始文件:不拿投影地址硬猜)", () => {
  function newStore(): { s: SessionStore; neutralStore: NeutralSessionStore } {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "rawpaths-neutral-")));
    const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    return { s, neutralStore };
  }

  function putSession(neutralStore: NeutralSessionStore, ns: string): void {
    neutralStore.put({
      ...emptyNeutralSession(ns, { kernel: "pi", cwd: CWD, createdAt: "2026-08-27T00:00:00.000Z" }),
      lineages: [{ lineageId: ns, fork: null, entries: [] }],
    });
  }

  it("中立会话 + 内核投影文件都在:两项都返回真实路径", async () => {
    const { s, neutralStore } = newStore();
    const ns = "ns-raw-both";
    putSession(neutralStore, ns);
    const kernelFile = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    mkdirSync(join(dir, "sessions", cwdToBucketName(CWD)), { recursive: true });
    writeFileSync(kernelFile, JSON.stringify({ type: "session", id: ns, cwd: CWD }) + "\n");
    const r = await s.rawFilePaths(ns);
    expect(r.desktop).toBe(neutralStore.filePathOf(ns));
    expect(r.kernel).toBe(kernelFile);
  });

  it("内核投影文件缺失(迁移前旧会话):kernel=null,desktop 仍返回——显式降级不静默", async () => {
    const { s, neutralStore } = newStore();
    const ns = "ns-raw-kernel-missing";
    putSession(neutralStore, ns);
    const r = await s.rawFilePaths(ns);
    expect(r.desktop).toBe(neutralStore.filePathOf(ns));
    expect(r.kernel).toBeNull();
  });

  it("会话不存在:两项皆 null", async () => {
    const { s } = newStore();
    expect(await s.rawFilePaths("ns-no-such")).toEqual({ desktop: null, kernel: null });
  });
});

describe("fork:父 lineage 尊重调用方指定(根因修复回归——此前硬取活跃分支)", () => {
  function newForkStore(): { s: SessionStore; neutralStore: NeutralSessionStore; ns: string } {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "fork-neutral-")));
    const ns = "ns-fork";
    neutralStore.put({
      ...emptyNeutralSession(ns, { kernel: "pi", cwd: CWD, createdAt: "2026-08-27T00:00:00.000Z" }),
      lineages: [
        { lineageId: ns, fork: null, entries: [] },
        { lineageId: "branch-B", fork: { parentLineageId: ns, boundaryEntryId: "" }, entries: [] },
      ],
    });
    const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    return { s, neutralStore, ns };
  }

  it("fork(parentLineageId=B):新 lineage 挂到 B,不是活跃分支", async () => {
    const { s, neutralStore, ns } = newForkStore();
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    const newId = await s.fork("branch-B", "boundary-entry-1");
    const tree = neutralStore.get(ns);
    const branch = tree?.lineages.find((l) => l.lineageId === newId);
    expect(branch?.fork?.parentLineageId).toBe("branch-B");
    expect(branch?.fork?.boundaryEntryId).toBe("boundary-entry-1");
  });

  it("fork(不存在的父):回落活跃 lineage 并 warn(不静默换父≠抛错打断)", async () => {
    const { s, neutralStore, ns } = newForkStore();
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    const newId = await s.fork("no-such-lineage");
    const branch = neutralStore.get(ns)?.lineages.find((l) => l.lineageId === newId);
    // 活跃 lineage = 根(ns,proc 初始化即根)
    expect(branch?.fork?.parentLineageId).toBe(ns);
  });
});

describe("dsh 热切与缺面回落(docs/model-switching.md §11,断言落在机制上:重启没重启)", () => {
  const dshTwoModels: KernelModelSource = {
    listModels: () => [
      { kernel: "dsh", provider: "us-new", id: "dsh-model-a", name: "dsh-model-a" },
      { kernel: "dsh", provider: "us-new", id: "dsh-model-b", name: "dsh-model-b" },
    ],
  };
  /** 双内核 catalog 工厂:dsh 惰性(newSessionId=null),pi 走真实目录。 */
  const dualCatalogFactory: SessionCatalogFactory = {
    create: (kernel) => kernel === "dsh"
      ? ({ kernel: "dsh", newSessionId: () => null, projectionPath: (_cwd: string, l: string) => l } as unknown as ReturnType<SessionCatalogFactory["create"]>)
      : new PiSessionCatalog(dir),
  };

  /** dsh 热切假后端(补丁在位的形态):supportsRuntimeSetModel=true,记录调用序列。
   *  注意能力位用 getter 不用字段——字段会在实例上落成自有属性,子类的 getter override
   *  会被它永久遮蔽(缺面回落用例的坑)。 */
  class FakeDshHotBackend {
    alive = false;
    capabilities = { dsh: { missing: new Set<string>(), onMissing: null as null | ((m: string) => void) } };
    get supportsRuntimeSetModel(): boolean { return true; }
    calls: string[] = [];
    constructor(public opts?: { neutralSessionId?: string }) {}
    get sessionId(): string { return this.opts?.neutralSessionId ?? "dsh-s1"; }
    async start(): Promise<void> { this.alive = true; this.calls.push("start"); }
    async stop(): Promise<void> { this.alive = false; this.calls.push("stop"); }
    onEvent(): () => void { return () => {}; }
    async sendMessage(): Promise<void> { this.calls.push("sendMessage"); }
    async setModel(p?: string, m?: string): Promise<void> { this.calls.push(`setModel:${p}/${m}`); }
    async setSessionName(): Promise<void> {}
    async seed(): Promise<string> { return "seeded"; }
    async getTree(): Promise<LineageTree> { return { rootId: "", lineages: [] }; }
    async getEntries(): Promise<NeutralMessage[]> { return []; }
    async bookmark(): Promise<Anchor> { return { lineageId: "", entryId: "" }; }
    async deleteBookmark(): Promise<void> {}
    async abort(): Promise<void> {}
    async continue(): Promise<void> { this.calls.push("continue"); }
  }

  function makeHotStore(): { s: SessionStore; created: { kernel: string; model?: string }[]; backends: FakeDshHotBackend[] } {
    const created: { kernel: string; model?: string }[] = [];
    const backends: FakeDshHotBackend[] = [];
    const factory: BackendFactory = {
      create: (opts) => {
        created.push({ kernel: opts.kernel, model: opts.model });
        const b = new FakeDshHotBackend({ neutralSessionId: opts.neutralSessionId });
        backends.push(b);
        return b as unknown as BaseBackend;
      },
    };
    const s = new SessionStore(factory, dualCatalogFactory, dir, undefined, undefined, new ModelCatalog([dshTwoModels]));
    s.setContext(CWD, null);
    return { s, created, backends };
  }

  it("dsh 热切:已物化会话换模型 → 进程不重启、setModel 恰好一次、分隔线恰好一条、账本跟到新模型", async () => {
    const { s, created, backends } = makeHotStore();
    await s.prompt("第一发", undefined, undefined, { provider: "us-new", modelId: "dsh-model-a", thinkingLevel: "", kernel: "dsh" });
    expect(created).toHaveLength(1);
    const b1 = backends[0];
    const dividerTypes: string[] = [];
    s.onEvent((e) => {
      if (e.type === "entryAppended") {
        const t = (e as { entry?: { type?: string } }).entry?.type;
        if (t) dividerTypes.push(t);
      }
    });
    b1.calls.length = 0;
    await s.setModel("us-new", "dsh-model-b", "dsh");
    // 机制断言:进程不重启(stop/start 零调用)、热切 RPC 恰好一次、分隔线恰好一条
    expect(b1.calls).not.toContain("stop");
    expect(b1.calls).not.toContain("start");
    expect(b1.calls.filter((c) => c === "setModel:us-new/dsh-model-b")).toHaveLength(1);
    expect(dividerTypes.filter((t) => t === "model_change")).toHaveLength(1);
    expect(created).toHaveLength(1); // 没起新进程
    // 账本更新:下一条同模型发送判「已生效」,不再重发 setModel
    b1.calls.length = 0;
    await s.prompt("第二发", undefined, undefined, { provider: "us-new", modelId: "dsh-model-b", thinkingLevel: "", kernel: "dsh" });
    expect(b1.calls).toContain("sendMessage");
    expect(b1.calls.filter((c) => c.startsWith("setModel"))).toHaveLength(0);
  });

  it("dsh 缺面回落:热切 RPC 撞缺面 → 现场停旧起新,新进程握手带目标模型", async () => {
    /** 懒探测形态假后端:setModel 撞 unknown method → 记缺面 → 能力位翻 false。 */
    class FakeDshMissingBackend extends FakeDshHotBackend {
      override async setModel(): Promise<void> {
        this.calls.push("setModel");
        this.capabilities.dsh.missing.add("session/setModel");
      }
      override get supportsRuntimeSetModel(): boolean {
        return !this.capabilities.dsh.missing.has("session/setModel");
      }
    }
    const created: { kernel: string; model?: string }[] = [];
    const backends: FakeDshHotBackend[] = [];
    const factory: BackendFactory = {
      create: (opts) => {
        created.push({ kernel: opts.kernel, model: opts.model });
        const b = new FakeDshMissingBackend({ neutralSessionId: opts.neutralSessionId });
        backends.push(b);
        return b as unknown as BaseBackend;
      },
    };
    const s = new SessionStore(factory, dualCatalogFactory, dir, undefined, undefined, new ModelCatalog([dshTwoModels]));
    s.setContext(CWD, null);
    await s.prompt("第一发", undefined, undefined, { provider: "us-new", modelId: "dsh-model-a", thinkingLevel: "", kernel: "dsh" });
    const b1 = backends[0];
    await s.setModel("us-new", "dsh-model-b", "dsh");
    // b1:热切尝试一次 → 撞缺面 → 被停;b2:带目标模型握手起来
    expect(b1.calls.filter((c) => c === "setModel")).toHaveLength(1);
    expect(b1.calls).toContain("stop");
    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({ kernel: "dsh", model: "dsh-model-b" });
    const b2 = backends[1];
    b2.calls.length = 0;
    await s.prompt("第二发", undefined, undefined, { provider: "us-new", modelId: "dsh-model-b", thinkingLevel: "", kernel: "dsh" });
    expect(b2.calls).toContain("sendMessage");
    expect(b2.calls.filter((c) => c.startsWith("setModel"))).toHaveLength(0);
  });

  it("dsh 未物化会话换模型:不走热切 RPC,直接停旧起新(握手是唯一定模点)", async () => {
    const { s, created, backends } = makeHotStore();
    await s.setModel("us-new", "dsh-model-a", "dsh"); // 起进程,未发消息(touched=false)
    expect(created).toHaveLength(1);
    const b1 = backends[0];
    b1.calls.length = 0;
    await s.setModel("us-new", "dsh-model-b", "dsh");
    expect(b1.calls).toContain("stop");
    expect(b1.calls.filter((c) => c.startsWith("setModel"))).toHaveLength(0);
    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({ kernel: "dsh", model: "dsh-model-b" });
  });

  it("pi 回归:未物化会话换模型不重启,set_model 热切照发(文件型内核不落入惰性重建)", async () => {
    let created = 0;
    const factory: BackendFactory = {
      create: (opts) => { created++; return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }); },
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, undefined, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath); // 起进程,touched=false
    adapter.sent = [];
    await s.setModel("p", "b", "pi");
    expect(created).toBe(1); // 不重建
    expect(adapter.sent).toContain("set_model"); // 热切 RPC 照发
  });
});

describe("sessionStart 携带 neutralSessionId(fork/bookmark 入口水合的命脉)", () => {  it("setContext 合成 sessionStart:事件带 proc.neutralSessionId", async () => {
    const events: { type: string; neutralSessionId?: string }[] = [];
    const off = store.onEvent((e) => events.push(e as { type: string; neutralSessionId?: string }));
    store.setContext(CWD, sessionPath); // 激活即推 synthetic sessionStart(进程已在 beforeEach 起过)
    off();
    const ev = events.find((e) => e.type === "sessionStart");
    expect(ev).toBeDefined();
    // ns = 派生路径 basename("s1")
    expect(ev?.neutralSessionId).toBe("s1");
  });
});

describe("合成分隔线双落点:视图流 + 中立层持久化(刷新/冷开不丢,pi/dsh 一致)", () => {
  it("setModel 换模型:中立层追加 model_change divider(刷新后可读回)", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "divider-neutral-")));
    const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    // 换一个模型(快照现值 p/a → p/b):触发 set_model + 合成分隔线
    await s.setModel("p", "b", "pi");
    const ns = "s1"; // 派生路径 basename
    const session = neutralStore.get(ns);
    expect(session).toBeDefined();
    const dividers = session!.lineages.flatMap((l) => l.entries).filter((e) => e.message.role === "divider");
    expect(dividers.some((e) => e.message.kind === "model" && (e.message.i18nArgs as { modelId?: string })?.modelId === "b")).toBe(true);
  });
});

describe("提问投递/作答(ask)的诚实性", () => {
  it("无可答进程时 injectQuestion 丢弃(陈旧/外来问句不再呈现成可答卡片)", () => {
    // 全新 store(不起进程):activeProc 不存在
    const s = new SessionStore(
      { create: () => { throw new Error("不应起进程"); } },
      catalogFactory, dir,
    );
    const got: unknown[] = [];
    s.onQuestion((q) => got.push(q));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    s.injectQuestion({ kind: "question", requestId: "stale-1", sessionKey: "", questions: [{ id: "q1", question: "?" }] } as never);
    expect(got).toHaveLength(0);
    expect(warn).toHaveBeenCalled(); // 丢弃要可诊断,不静默
    warn.mockRestore();
  });

  it("answerQuestion 无进程:诚实文案(提问已失效),不再是误导性的「内核未启动」", async () => {
    const s = new SessionStore(
      { create: () => { throw new Error("不应起进程"); } },
      catalogFactory, dir,
    );
    await expect(s.answerQuestion("r1", [])).rejects.toThrow("提问已失效");
  });

  it("有活进程:投递照常(回归——别把正常 ask 掐死)", async () => {
    // 外层 beforeEach 的 store 已起 pi 会话进程
    const got: unknown[] = [];
    const off = store.onQuestion((q) => got.push(q));
    store.injectQuestion({ kind: "question", requestId: "live-1", sessionKey: "", questions: [{ id: "q1", question: "?" }] } as never);
    off();
    expect(got).toHaveLength(1);
  });
});
