// SessionStore 差量执行裸单测(docs/design/session-model-config.md §4.3):
// setModel/setThinkingLevel 经 ensureForSend 拿到实证快照后,进程已持目标值即跳过 RPC
// (同值 set_model 会在时间线落 model_change 分隔线);实况有差或快照缺失才发。
// fixture:tmp 目录真会话文件(updateSessionHeader 要求头行真实存在);FakeAdapter
// 记录发出的命令 type,不 mock 框架。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { SessionStore, type BackendFactory } from "./session-store";
import { PiBackend } from "../../kernel/pi/backend/pi-backend";
import { PiSessionCatalog } from "../../kernel/pi/backend/pi-catalog";
import { cwdToBucketName } from "@my-harness-desktop/shared";
import type { RpcAdapter } from "../../kernel/pi/backend/rpc-adapter";
import type { RpcCommand } from "../../kernel/pi/protocol/rpc-types";
import type { BaseBackend, LineageTree, Anchor, BoundaryRef, SessionCatalog, SessionCatalogFactory, KernelModelSource } from "@my-harness-desktop/shared";
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
  it("dsh 后端(无 pi 扩展面)abort 不崩、真中断到底——abort 内核无关,不再经 asPi", async () => {
    // 根因守卫:abort 曾手写 pi 专属 abortBash 顺序(经 asPi,dsh 上同步抛崩中断),dsh 会话
    // 停止按钮完全失效(实弹复现:停止钮不消失、无 stopped 落盘)。修复:两段中断收进
    // PiBackend.abort(§6.4),壳的 SessionStore.abort 只调 backend.abort——dsh 走
    // DshBackend.abort 各自干净,壳不再引用 asPi。
    const dshMock = new MockBackend();
    const dshSource: KernelModelSource = {
      listModels: () => [{ kernel: "dsh", provider: "us-new", id: "dsh-model", name: "dsh-model" }],
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const dshFactory: BackendFactory = {
      create: (opts) => opts.kernel === "dsh"
        ? dshMock as unknown as BaseBackend
        : new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
    };
    const dshStore = new SessionStore(dshFactory, catalogFactory, dir, undefined, undefined, catalog);
    dshStore.setContext(CWD, null); // 空会话
    await dshStore.setModel("us-new", "dsh-model", "dsh"); // 选 dsh 模型 → 起 dsh 后端
    await expect(dshStore.abort()).resolves.toBeUndefined();
    expect(dshMock.calls).toContain("abort");
  });

  it("dsh 会话 forkFromSession 派生新会话(中性面,内核无关;unify §7.1——不再是会话内分支)", async () => {
    // forkFromSession 已收编为「派生新会话」(同一 deriveSession 派生核):源会话不动,
    // 新会话携物化前缀 + pendingSeed + derivedFrom,激活切到新会话;dsh 会话同一条路径
    // (不再走 pi 扩展面——doc Q&A:dsh 下点 ForkAction 正常分叉)。
    const dshMock = new MockBackend();
    const dshSource: KernelModelSource = {
      listModels: () => [{ kernel: "dsh", provider: "us-new", id: "dsh-model", name: "dsh-model" }],
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const dshFactory: BackendFactory = {
      create: (opts) => opts.kernel === "dsh"
        ? dshMock as unknown as BaseBackend
        : new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
    };
    const neutralStore = new NeutralSessionStore(join(dir, "neutral"));
    const dshStore = new SessionStore(dshFactory, catalogFactory, dir, undefined, neutralStore, catalog);
    dshStore.setContext(CWD, null);
    await dshStore.setModel("us-new", "dsh-model", "dsh");
    await dshStore.prompt("ping base"); // 建中立层会话 + 一条 user
    const srcNs = neutralStore.listByCwd(CWD)[0]!.neutralSessionId;
    const srcBefore = neutralStore.get(srcNs)!;
    expect(srcBefore.lineages).toHaveLength(1);
    const userEntry = srcBefore.lineages[0].entries.find((e) => e.message.role === "user")!;
    const newNs = await dshStore.forkFromSession(CWD, srcNs, userEntry.neutralEntryId, "at");
    // 返回新 neutralSessionId(契约 §7.1);源会话不动(派生是拷贝不是改源,不插分支)
    expect(newNs).not.toBe(srcNs);
    expect(neutralStore.get(srcNs)!.lineages).toHaveLength(1);
    // 新会话:根 lineageId ≡ 新 ns,内核归属随源(dsh),pendingSeed 置位,derivedFrom 记源
    const derived = neutralStore.get(newNs)!;
    expect(derived.lineages).toHaveLength(1);
    expect(derived.lineages[0].lineageId).toBe(newNs);
    expect(derived.header.kernel).toBe("dsh");
    expect(derived.header.pendingSeed).toBe(true);
    expect(derived.header.derivedFrom).toEqual({ kind: "fork", sourceNeutralSessionId: srcNs, boundaryEntryId: userEntry.neutralEntryId });
    // 内容 = 源前缀物化到锚点(含锚点 user 消息);中立 id 已重投影到新 ns
    const contents = derived.lineages[0].entries.map((e) => String(e.message.content));
    expect(contents).toContain("ping base");
    expect(derived.lineages[0].entries.every((e) => e.neutralEntryId.startsWith(`${newNs}:`))).toBe(true);
    // 列表立即可见(§5.4):同 cwd 两个会话
    expect(neutralStore.listByCwd(CWD)).toHaveLength(2);
    // 激活切到新会话(派生 → 跳转,§6.1)
    expect((dshStore as unknown as { activeSessionPath: string | null }).activeSessionPath).toBeTruthy();
  });

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
  sessionId = "dsh-s1"; // RPC 内核的会话标识(switchKernel 空会话分支的「身份不变量」依赖)
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
describe("switchKernel 五步切换(测试内翻 gate,验证 pi→dsh「文件态→RPC」过渡,生产 gate 仍关)", () => {
  it("pi → dsh(空会话):新后端 start、跳过 seed,旧后端 abort + stop", async () => {
    const mock = new MockBackend();
    const factory: BackendFactory = {
      create: (opts) => opts.kernel === "dsh"
        ? mock as unknown as BaseBackend
        : new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
    };
    const s = new SessionStore(factory, catalogFactory, dir);
    (s as unknown as { switchKernelEnabled: boolean }).switchKernelEnabled = true;
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

describe("switchKernel 七步(测试内翻 gate,验证 minimal 侧就绪,生产 gate 仍关)", () => {
  it("pi → minimal:fileBacked 走预 seed 重 spawn(seed 返派生路径 + start 新后端 + 旧 pi abort/stop)", async () => {
    const minimalMock = new MockBackend();
    // minimal 是文件态内核:capabilities.fileBacked=true(无 pi 面)——区别于 dsh 的 RPC。
    (minimalMock as unknown as { capabilities: { fileBacked?: boolean } }).capabilities = { fileBacked: true };
    const seededKernels: string[] = [];
    const factory: BackendFactory = {
      create: (opts) => opts.kernel === "minimal"
        ? minimalMock as unknown as BaseBackend
        : new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
      seed: async (_lineage, opts) => { seededKernels.push(opts.kernel); return (opts.kernel === "minimal" ? "minimal-derived-s1" : null); },
    };
    const s = new SessionStore(factory, catalogFactory, dir);
    (s as unknown as { switchKernelEnabled: boolean }).switchKernelEnabled = true;
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    adapter.sent = [];

    await s.switchKernel("minimal");

    // 旧 pi:abort(step 1)+ stop(step 3)
    expect(adapter.sent).toContain("abort");
    expect(adapter.alive).toBe(false);
    // 新 minimal:fileBacked → factory.seed 返派生路径 + start 新后端(step 4 预 seed 分支)
    expect(seededKernels).toContain("minimal");
    expect(minimalMock.calls).toContain("start");
  });

  it("dsh → minimal(RPC → 文件态):seed 返派生路径 + start 新后端 + 旧 dsh abort/stop", async () => {
    const dshMock = new MockBackend();
    const minimalMock = new MockBackend();
    (minimalMock as unknown as { capabilities: { fileBacked?: boolean } }).capabilities = { fileBacked: true };
    const seededKernels: string[] = [];
    const factory: BackendFactory = {
      create: (opts) => opts.kernel === "minimal"
        ? minimalMock as unknown as BaseBackend
        : opts.kernel === "dsh"
          ? dshMock as unknown as BaseBackend
          : new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
      seed: async (_lineage, opts) => { seededKernels.push(opts.kernel); return (opts.kernel === "minimal" ? "minimal-derived-s1" : null); },
    };
    const s = new SessionStore(factory, catalogFactory, dir);
    (s as unknown as { switchKernelEnabled: boolean }).switchKernelEnabled = true;
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath, undefined, false, "dsh", "us-new", "dsh-model"); // 起 dsh(RPC)

    await s.switchKernel("minimal");

    // 旧 dsh:abort(step 1)+ stop(step 3)
    expect(dshMock.calls).toContain("abort");
    expect(dshMock.alive).toBe(false);
    // 新 minimal:RPC → 文件态,factory.seed 返派生路径 + start 新后端
    expect(seededKernels).toContain("minimal");
    expect(minimalMock.calls).toContain("start");
  });
});

describe("setModel 跨内核路由(中间转换层)", () => {
  it("模型属于 dsh 而当前是 pi(有历史,发过消息):七步切换(switchKernel),dsh 模型不落到 pi", async () => {
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

    // §8 已启用:有历史 pi 进程选 dsh 模型 → 七步切换(不再显式降级抛错)
    await s.setModel("us-new", "bifrost/tencent/deepseek-v4-pro", "dsh");

    // 切换动作:pi abort + stop(step 1/3),dsh mock start(step 4 RPC 分支)
    expect(adapter.sent).toContain("abort");
    expect(adapter.alive).toBe(false);
    expect(mock.calls).toContain("start");
  });

  it("setModel 固定内核取会话自身 header.kernel 而非全局 activeKernel:切回有历史的 pi 会话不被误拦(根因守卫)", async () => {
    // 根因:setModel 的 fixedKernel 用 activeKernel(全局「最后一次选的内核」,跨会话残留)优先,
    // 而非会话自身上下文 header.kernel。从 dsh 会话切回有历史的 pi 会话时 activeKernel 残留 dsh,
    // fixedKernel 取到 dsh → 误判「当前会话已固定内核,跨内核切换后续支持」挡发(实弹:
    // pi→dsh→pi 切回后 pi 续发停止钮不出、回合不起)。真相源应是会话自身的 header.kernel。
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "xkern-switch-neutral-")));
    const piNs = "ns-pi";
    const dshNs = "ns-dsh";
    // 有历史的 pi 会话(header.kernel=pi + 一条 user entry)
    neutralStore.put({
      ...emptyNeutralSession(piNs, { kernel: "pi", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z" }),
      lineages: [{ lineageId: piNs, fork: null, entries: [{ neutralEntryId: `${piNs}:0`, message: { role: "user", content: "hi" } }] }],
    });
    // dsh 会话(header.kernel=dsh,空历史)
    neutralStore.put(emptyNeutralSession(dshNs, { kernel: "dsh", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z" }));
    const dshSource: KernelModelSource = {
      listModels: () => [{ kernel: "dsh", provider: "us-new", id: "dsh-model", name: "dsh-model" }],
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const mock = new MockBackend();
    const factory: BackendFactory = {
      create: (opts) => opts.kernel === "dsh"
        ? mock as unknown as BaseBackend
        : new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }),
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, catalog);
    const piPath = join(dir, "sessions", cwdToBucketName(CWD), `${piNs}.jsonl`);
    const dshPath = dshNs; // dsh 投影路径 = 根 lineageId(= ns)

    // ① 先到 dsh 会话:setContext(dsh) + setModel(dsh) + 发一条(dsh 会话变 touched,有历史)
    s.setContext(CWD, dshPath);
    await s.setModel("us-new", "dsh-model", "dsh");
    await s.prompt("dsh msg"); // touched → 切走不回收(忠实于实弹:dsh 会话有内容)
    // ② 切回有历史的 pi 会话:setContext(pi) → activeKernel 应换绑回 pi
    s.setContext(CWD, piPath);
    // ③ pi 会话再选 pi 模型:修复前 activeKernel 仍 dsh → hasHistory(pi 有历史)=true → 撞闸抛错
    await expect(s.setModel("p", "a", "pi")).resolves.toBeUndefined();
  });
});


describe("内核跟随模型(清理默认 pi + 跨内核切换,kernel-follows-model.md)", () => {
  it("switchKernel gate 已开:不再抛「暂未启用」,七步编排运行", async () => {
    await expect(store.switchKernel("dsh")).rejects.not.toThrow("跨内核切换暂未启用");
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

  it("重开历史 dsh 会话续发:生产 factory.seed 恒定义(返 null)也照常 seed 回填(materializedLineageId 惰性化守卫)", async () => {
    // 根因守卫:createProc 的 materializedLineageId 曾用 `this.factory.seed ? ns : ""`(函数存在
    // 判「有无预 seed 面」),但生产 factory.seed 恒定义(dsh 返 null 表 RPC seed)→ 恒真 →
    // dsh 也标 ns=已物化 → materializeActiveLineage 提前 return、seed 跳过、历史丢失。而
    // 旧测试用 makeDshFactory(无 seed 函数)掩盖了它(走了 seedFn==null 的 in-place 分支)。
    // 本测试用「生产形态」工厂(seed 定义但返 null),钉死重开仍 seed。
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "matlineage-neutral-")));
    const ns = "ns-matlineage";
    neutralStore.put({
      ...emptyNeutralSession(ns, { kernel: "dsh", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z" }),
      lineages: [{ lineageId: ns, fork: null, entries: [{ neutralEntryId: `${ns}:0`, message: { role: "user", content: "hi" } }] }],
    });
    const created: string[] = [];
    const backends: { calls: string[]; seedLineageLength: number | null }[] = [];
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const factory: BackendFactory = {
      // 生产形态:seed 定义,对 dsh 返 null(走 create → start → backend.seed)
      seed: async () => null,
      create: (opts) => {
        created.push(opts.kernel);
        const b = new FakeDshRoutingBackend();
        backends.push(b as unknown as { calls: string[]; seedLineageLength: number | null });
        return b as unknown as BaseBackend;
      },
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, catalog);
    s.setContext(CWD, ns);
    await s.prompt("重开后续聊", undefined, undefined, { provider: "us-new", modelId: "dsh-model", thinkingLevel: "", kernel: "dsh" });
    const b = backends[0];
    expect(b.calls).toContain("seed"); // 惰性物化后重开仍 seed 回填历史
    expect(b.seedLineageLength).toBeGreaterThan(0);
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
    // 摘要不带 entries(§neutral-storage-split §2.3):断言条目数走 get 全量读
    const full = neutralStore.get(sessions[0].neutralSessionId)!;
    expect(full.lineages.flatMap((l) => l.entries).filter((e) => e.message.role === "user")).toHaveLength(2);
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
      // 摘要不带 entries(§neutral-storage-split §2.3):断言条目数走 get 全量读
      const fullSess = neutralStore.get(sess.neutralSessionId)!;
      const userEntries = fullSess.lineages.flatMap((l) => l.entries).filter((e) => e.message.role === "user");
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

  it("dsh(无 capabilities.extensions)prompt 带 thinkingLevel:跳过 setThinkingLevel,不抛错、正常发送", async () => {
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

  it("pi(有 capabilities.extensions)prompt 带 thinkingLevel:仍走 setThinkingLevel,不回归", async () => {
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

  it("custom 按键合并(根因守卫,r317 实弹):分片写不抹同域他键——goal 写 {custom:{goal}} 后 custom.model 必须仍在", async () => {
    // 根因:writeNeutralHeader 曾把 custom 整域赋值。goal 控制器每次 updateHeader({custom:{goal}})
    // 都会把 setModel 落的 custom.model(模型域,续发/重开的偏好解析真相源)抹掉——
    // 实弹 r317:派生会话设目标后下一轮续跑 promptSession 读不到模型域 →
    // 「会话未启动,请先选择模型」→ goal auto_pause_send_failed 停摆。
    // 修复:custom 按键合并(patch 键覆盖,未提及键保留;显式 null=删键)。
    const { s, neutralStore, ns, sessionPath } = newNeutralStore();
    // 预置模型域(模拟 setModel 已写)+ 工具配置键
    const cur = neutralStore.get(ns)!;
    neutralStore.put({
      ...cur,
      header: { ...cur.header, custom: { ...(cur.header.custom ?? {}), model: { provider: "p", modelId: "a", thinkingLevel: "high", kernel: "pi" }, toolConfig: { enabledToolIds: ["bash"] } } },
    });
    // goal 分片写(控制器实弹形态)
    await s.updateHeader(sessionPath, { custom: { goal: { objective: "x", phase: "active", round: 1, maxRounds: 3 } } });
    const h = neutralStore.get(ns)?.header;
    const cust = h?.custom as Record<string, unknown>;
    expect(cust.model).toEqual({ provider: "p", modelId: "a", thinkingLevel: "high", kernel: "pi" }); // 模型域幸存
    expect((cust.goal as { phase: string }).phase).toBe("active"); // 分片键写入
    expect(cust.toolConfig).toEqual({ enabledToolIds: ["bash"] }); // 他键幸存
    expect(cust.subagent).toEqual({ parent_id: "main" }); // 预置键也幸存
    // 二次分片写:goal 清档(null=删键)也不动 model
    await s.updateHeader(sessionPath, { custom: { goal: null } });
    const h2 = neutralStore.get(ns)?.header;
    const cust2 = h2?.custom as Record<string, unknown>;
    expect(cust2.goal).toBeUndefined(); // 显式 null = 删键
    expect(cust2.model).toBeTruthy(); // 模型域仍幸存
    expect(cust2.subagent).toEqual({ parent_id: "main" });
  });

  it("updateHeader 的 toolConfig 落中立层(根因守卫,r328 实钉:此前 toolConfig 从不进 custom)", async () => {
    // 根因:HeaderPatch 声明 toolConfig「落 custom-my-harness-desktop.toolConfig 保留键」,
    // 但 updateHeader 的 writeNeutralHeader patch 只转 name/pinned/archived/custom 四键,
    // toolConfig 被整个丢弃——中立层(真相源)永远查无此键。pi 会话靠投影文件(penalty:
    // 读路径恰好也读 pi 文件)勉强闭环;dsh 会话无 pi 文件 → 工具限制发完即丢(静默失效,
    // 违反 §7.6 不静默 + session-single-source「中立层是唯一真相源」)。
    const { s, neutralStore, ns, sessionPath } = newNeutralStore();
    await s.updateHeader(sessionPath, { toolConfig: { enabledGroupIds: [], enabledToolIds: ["bash"] } });
    const cust = neutralStore.get(ns)?.header.custom as Record<string, unknown>;
    expect(cust.toolConfig).toEqual({ enabledGroupIds: [], enabledToolIds: ["bash"] }); // 进中立层
    expect(cust.subagent).toEqual({ parent_id: "main" }); // r317 按键合并:他键幸存
    // 删键语义(null = 删 toolConfig,不动他键)
    await s.updateHeader(sessionPath, { toolConfig: null });
    const cust2 = neutralStore.get(ns)?.header.custom as Record<string, unknown>;
    expect(cust2.toolConfig).toBeUndefined();
    expect(cust2.subagent).toEqual({ parent_id: "main" });
    // 与 custom 同帧共存:custom 写 goal + toolConfig 一起写,两键都进且他键幸存
    await s.updateHeader(sessionPath, { custom: { goal: { objective: "g", phase: "active", round: 1, maxRounds: 3 } }, toolConfig: { enabledGroupIds: ["exec"], enabledToolIds: [] } });
    const cust3 = neutralStore.get(ns)?.header.custom as Record<string, unknown>;
    expect((cust3.toolConfig as { enabledGroupIds: string[] }).enabledGroupIds).toEqual(["exec"]);
    expect((cust3.goal as { phase: string }).phase).toBe("active");
    expect(cust3.subagent).toEqual({ parent_id: "main" });
  });

  it("openSession 双形态归一:中立 ns 与投影路径都能开(入参不对称收口,不再静默查空)", async () => {
    // 根因守卫:openSession 经 resolveNs 归一——裸 ns 与投影路径(<cwd>/…/<rootLineageId>.jsonl)
    // 都命中同一中立会话。此前裸 get 传投影路径静默返回 null(调用方「点了没反应」零信号),
    // 是 §1.5 静默缺面式设计。现在把「双形态都收」钉成契约,而不是把「只认 ns」钉成契约。
    const { s, sessionPath, ns } = newNeutralStore();
    const byNs = await s.openSession(ns);
    const byPath = await s.openSession(sessionPath);
    expect(byNs).not.toBeNull();
    expect(byPath).not.toBeNull();
    expect(byPath?.info?.neutralSessionId).toBe(ns); // 双形态落到同一会话
  });

  it("openSession 锚点契约:每条消息必带 id(中立 entryId 提升;存量 message.id 缺失不得丢行)", async () => {
    // 根因守卫(r309f 实弹):openSession 曾手抄一份「e.message 直返」的内联映射,漏了
    // id 提升——写穿路径未回填 message.id 的存量条目(实测 dsh/部分 pi 条目),openSession
    // 后 id=undefined → 渲染层 MessageRow 的 data-message-id={message.id ?? undefined}
    // 整个属性丢失 → 该行从 [data-message-id] 锚点查询消失(悬停动作/rewind/评论锚全断),
    // 且文件 5 条、RPC 5 条、DOM 锚点只见 4 行的「凭空少一行」。修复=openSession 走
    // 圆心单源投影 neutralMessagesOfSession(id 恒为 {neutralEntryId}),本测试钉死契约。
    const { s, neutralStore, ns } = newNeutralStore();
    // 构造实弹形态:条目的 message.id 缺失(写穿未回填的存量数据),neutralEntryId 在
    neutralStore.put({
      ...neutralStore.get(ns)!,
      lineages: [{
        lineageId: ns,
        fork: null,
        entries: [
          { neutralEntryId: `${ns}:0`, message: { role: "divider", kind: "model", content: "" } },
          { neutralEntryId: `${ns}:1`, message: { role: "user", content: "ping sA" } },
          { neutralEntryId: `${ns}:2`, message: { role: "assistant", content: "pong" } }, // 无 message.id
        ],
      }],
    });
    const detail = await s.openSession(ns);
    expect(detail).not.toBeNull();
    // 锚点契约:全部消息 id 非空,且等于条目的中立 entryId(跨内核稳定坐标)
    for (const m of detail!.messages) {
      expect(typeof m.id).toBe("string");
      expect(m.id).toBeTruthy();
    }
    const userMsg = detail!.messages.find((m) => m.role === "user")!;
    const asstMsg = detail!.messages.find((m) => m.role === "assistant")!;
    expect(userMsg.id).toBe(`${ns}:1`);
    expect(asstMsg.id).toBe(`${ns}:2`);
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

describe("内核投影取舍(neutral-storage-split §2.5):{pinned,archived} 纯补丁跳过内核写", () => {
  /** 带记账 catalog 的 store:catalog 的 rename/updateHeader 调用全记录,
   *  据此钉死「哪些补丁投影、哪些跳过」的边界。 */
  function newSpyingStore(): { s: SessionStore; neutralStore: NeutralSessionStore; ns: string; sessionPath: string; calls: { rename: number; updateHeader: number } } {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "session-store-proj-skip-")));
    const ns = "ns-proj-skip";
    neutralStore.put(emptyNeutralSession(ns, { kernel: "pi", cwd: CWD, createdAt: "2026-08-27T00:00:00.000Z" }));
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    const calls = { rename: 0, updateHeader: 0 };
    const real = new PiSessionCatalog(dir);
    const spying: SessionCatalog = {
      ...real,
      kernel: "pi",
      rename: async (id, name) => { calls.rename++; return real.rename(id, name); },
      updateHeader: async (id, patch) => { calls.updateHeader++; return real.updateHeader(id, patch); },
    } as SessionCatalog;
    const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
    const s = new SessionStore(factory, { create: () => spying }, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    s.setContext(CWD, sessionPath);
    return { s, neutralStore, ns, sessionPath, calls };
  }

  it("纯归档补丁:中立层照写,内核投影零调用(整文件重写的冗余被砍掉)", async () => {
    const { s, neutralStore, ns, sessionPath, calls } = newSpyingStore();
    await s.updateHeader(sessionPath, { archived: true });
    expect(neutralStore.getHeader(ns)?.header.archived).toBe(true); // 真相源照写
    expect(calls.rename).toBe(0);
    expect(calls.updateHeader).toBe(0); // 投影跳过
  });

  it("pinned+archived 混合纯补丁同样跳过", async () => {
    const { s, sessionPath, calls } = newSpyingStore();
    await s.updateHeader(sessionPath, { pinned: true, archived: false });
    expect(calls.rename).toBe(0);
    expect(calls.updateHeader).toBe(0);
  });

  it("name 照投(rename 有内核侧消费者:pi session_info 条目)", async () => {
    const { s, neutralStore, ns, sessionPath, calls } = newSpyingStore();
    await s.updateHeader(sessionPath, { name: "改名" });
    expect(calls.rename).toBe(1);
    expect(neutralStore.getHeader(ns)?.header.name).toBe("改名");
  });

  it("toolConfig 照投(tool-gate 内核扩展进程内读头行,真实消费者)", async () => {
    const { s, neutralStore, ns, sessionPath, calls } = newSpyingStore();
    await s.updateHeader(sessionPath, { toolConfig: { enabledGroupIds: [], enabledToolIds: ["bash"] } });
    expect(calls.updateHeader).toBe(1);
    const cust = neutralStore.getHeader(ns)?.header.custom as Record<string, unknown>;
    expect(cust.toolConfig).toEqual({ enabledGroupIds: [], enabledToolIds: ["bash"] });
  });

  it("name+archived 混合补丁:name 投影、archived 不单独投影(搭 rename 的车)", async () => {
    const { s, neutralStore, ns, sessionPath, calls } = newSpyingStore();
    await s.updateHeader(sessionPath, { name: "混合", archived: true });
    expect(calls.rename).toBe(1);
    // rest={archived} ⊆ {pinned,archived} → updateHeader 跳过,不再多一次整文件重写
    expect(calls.updateHeader).toBe(0);
    const h = neutralStore.getHeader(ns)?.header;
    expect(h?.name).toBe("混合");
    expect(h?.archived).toBe(true);
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

describe("fork:父 lineage 尊重调用方指定 + 派生新会话(根因修复回归——此前硬取活跃分支)", () => {
  // fork = 派生新会话(bookmark-snapshot-fork-unify §5):分叉把「调用方指定父 lineage 的前缀」
  // 物化成全新中立会话(新 ns + 根 lineageId ≡ ns),不立刻发起请求(惰性,首发物化)。
  function newForkStore(): { s: SessionStore; neutralStore: NeutralSessionStore; ns: string } {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "fork-neutral-")));
    const ns = "ns-fork";
    neutralStore.put({
      ...emptyNeutralSession(ns, { kernel: "pi", cwd: CWD, createdAt: "2026-08-27T00:00:00.000Z" }),
      lineages: [
        { lineageId: ns, fork: null, entries: [{ neutralEntryId: `${ns}:0`, message: { role: "user", content: "root-msg" } }] },
        // branch-B:从根的 :0 叉出,自己有一条独有条目——物化内容 = 根前缀 + B 独有
        { lineageId: "branch-B", fork: { parentLineageId: ns, boundaryEntryId: `${ns}:0` }, entries: [{ neutralEntryId: "branch-B:0", message: { role: "user", content: "on-B" } }] },
      ],
    });
    const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    return { s, neutralStore, ns };
  }

  it("fork(parentLineageId=B):派生新会话,内容 = B 的物化前缀(根前缀 + B 独有),不是活跃根分支", async () => {
    const { s, neutralStore, ns } = newForkStore();
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    const newPath = await s.fork("branch-B", "branch-B:0");
    // 返回新会话的投影路径;中立层多出全新会话(列表立即可见)
    const newNs = basename(newPath, ".jsonl");
    expect(newNs).not.toBe(ns);
    const derived = neutralStore.get(newNs)!;
    expect(derived).toBeTruthy();
    // 根 lineageId ≡ 新 ns(unify §5.2 不变量),唯一一条根 lineage
    expect(derived.lineages).toHaveLength(1);
    expect(derived.lineages[0].lineageId).toBe(newNs);
    expect(derived.lineages[0].fork).toBeNull();
    // 内容 = branch-B 的物化前缀(根前缀 root-msg + B 独有 on-B)——硬取活跃根分支只会得 [root-msg]
    expect(derived.lineages[0].entries.map((e) => e.message.content)).toEqual(["root-msg", "on-B"]);
    // 内容重投影(§5.3):中立 id 按新 ns 重算,内核坐标 kernelEntryId/message.id 清空
    expect(derived.lineages[0].entries.map((e) => e.neutralEntryId)).toEqual([`${newNs}:0`, `${newNs}:1`]);
    expect(derived.lineages[0].entries.every((e) => e.kernelEntryId === undefined && e.message.id === undefined)).toBe(true);
    // derivedFrom 记源 + 归一后的中立边界坐标(§4.3);pendingSeed 置位(§6.5 首发强制物化)
    expect(derived.header.derivedFrom).toEqual({ kind: "fork", sourceNeutralSessionId: ns, boundaryEntryId: "branch-B:0" });
    expect(derived.header.pendingSeed).toBe(true);
    // 源会话不动(派生是拷贝不是改源)
    expect(neutralStore.get(ns)!.lineages).toHaveLength(2);
    // 激活已切到新会话
    expect((s as unknown as { activeSessionPath: string }).activeSessionPath).toBe(newPath);
  });

  it("fork(不存在的父):回落活跃 lineage 并 warn(不静默换父≠抛错打断)", async () => {
    const { s, neutralStore, ns } = newForkStore();
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const newPath = await s.fork("no-such-lineage", `${ns}:0`);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    // 回落活跃 lineage(根 ns,proc 初始化即根):派生内容 = 根前缀(不是别条分支的)
    const derived = neutralStore.get(basename(newPath, ".jsonl"))!;
    expect(derived.lineages[0].entries.map((e) => e.message.content)).toEqual(["root-msg"]);
  });

  it("fork(before 首条):空边界 = 零继承前缀(§4.4),派生空会话不抛错(retry 首条消息的合法形态)", async () => {
    const { s, neutralStore, ns } = newForkStore();
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    // retry 首条 user 消息:position=before 且锚点是父内容第一条 → 边界空串(零继承前缀)
    const newPath = await s.fork(ns, `${ns}:0`, "before");
    const derived = neutralStore.get(basename(newPath, ".jsonl"))!;
    expect(derived.lineages[0].entries).toEqual([]); // 零继承:空前缀,重发时从零开始
    expect(derived.header.derivedFrom).toEqual({ kind: "fork", sourceNeutralSessionId: ns, boundaryEntryId: "" });
  });

  it("fork(锚点在分支、调用方传根):按锚点归属纠偏父 lineage(会话树面板恒传根,节点可能在分支上)", async () => {
    const { s, neutralStore, ns } = newForkStore();
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath);
    // 调用方传根 ns(会话树面板形态),锚点 branch-B:0 却属于 branch-B——
    // 条目属于且只属于一条 lineage,归属 lineage 是语义正确的父。
    const newPath = await s.fork(ns, "branch-B:0");
    const derived = neutralStore.get(basename(newPath, ".jsonl"))!;
    // 内容 = branch-B 的物化前缀(根前缀 + B 独有),不是「锚点不在根里」抛错、也不是根前缀截断
    expect(derived.lineages[0].entries.map((e) => e.message.content)).toEqual(["root-msg", "on-B"]);
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
    capabilities = { thinking: { missing: new Set<string>(), onMissing: null as null | ((m: string) => void) } };
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
        this.capabilities.thinking.missing.add("session/setModel");
      }
      override get supportsRuntimeSetModel(): boolean {
        return !this.capabilities.thinking.missing.has("session/setModel");
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

describe("resume 根 lineage 不变量(root lineageId ≡ neutralSessionId,unify §5.2)", () => {
  class ResumeBackend {
    alive = false;
    capabilities = { pi: false };
    calls: string[] = [];
    async start(): Promise<void> { this.alive = true; this.calls.push("start"); }
    async stop(): Promise<void> { this.alive = false; this.calls.push("stop"); }
    onEvent(): () => void { return () => {}; }
    async sendMessage(): Promise<void> { this.calls.push("sendMessage"); }
    async setModel(): Promise<void> {}
    async setSessionName(): Promise<void> {}
    async seed(): Promise<string> { this.calls.push("seed"); return "seeded"; }
    async fork(): Promise<unknown> { return { lineageId: "f", sessionReplaced: false }; }
    async getTree(): Promise<LineageTree> { return { rootId: "", lineages: [] }; }
    async getEntries(): Promise<NeutralMessage[]> { return []; }
    async bookmark(): Promise<Anchor> { return { lineageId: "", entryId: "" }; }
    async deleteBookmark(): Promise<void> {}
    async abort(): Promise<void> {}
  }

  it("发起收藏后新会话根 lineage 取会话主键(不另开随机 UUID)", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "resume-neutral-")));
    const bookmarkDir = mkdtempSync(join(tmpdir(), "resume-bookmark-"));
    // 预置快照文件(自包含:source 字段仅供溯源,不读源会话)
    const snapId = "bm-1";
    writeFileSync(join(bookmarkDir, `${snapId}.json`), JSON.stringify({
      version: 1, id: snapId, label: "收藏", preview: "hi", createdAt: "now",
      sourceKernel: "dsh", sourceNeutralSessionId: "src-ns",
      boundaryEntryId: "src:0",
      lineage: { lineageId: "src", entries: [{ neutralEntryId: "src:0", message: { role: "user", content: "hi" } }] },
    }));
    const factory: BackendFactory = { create: () => new ResumeBackend() as unknown as BaseBackend };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, undefined, () => bookmarkDir);
    s.setContext(CWD, null);
    const anchorId = await s.resume(snapId);
    // 新会话:根 lineage 必须 == neutralSessionId(不变量)
    const sessions = neutralStore.listByCwd(CWD);
    expect(sessions).toHaveLength(1);
    const ns = sessions[0].neutralSessionId;
    const rootLineage = neutralStore.get(ns)!.lineages.find((l) => l.fork === null)!;
    expect(rootLineage.lineageId).toBe(ns); // 根 lineageId ≡ neutralSessionId
    // 返回新会话里锚点的中立坐标(重投影后 id,scrollTo 定位用)——不是源会话坐标、不是投影路径
    expect(anchorId).toBe(`${ns}:0`); // 单条快照前缀,边界=第 0 条
  });
});

describe("三会话跨内核切换(pi/dsh/pi,会话对应进程不串)", () => {
  class TriBackend {
    alive = false;
    capabilities: { pi?: unknown } = {}; // 无 pi 扩展面(避免 bindProcEvents 走 onBusFrame 假面)
    calls: string[] = [];
    constructor(public kernel: "pi" | "dsh") {}
    async start(): Promise<void> { this.alive = true; this.calls.push("start"); }
    async stop(): Promise<void> { this.alive = false; this.calls.push("stop"); }
    onEvent(): () => void { return () => {}; }
    async sendMessage(): Promise<void> { this.calls.push("sendMessage"); }
    async setModel(): Promise<void> {}
    async setSessionName(): Promise<void> {}
    async seed(): Promise<string> { this.calls.push("seed"); return "seeded"; }
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

  it("pi-A/dsh-B/pi-C 三会话来回切换,各自发送不串、不撞「已固定内核」", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "tri-neutral-")));
    // 三会话:pi-A、dsh-B、pi-C,各带历史(有 entry)
    const make = (ns: string, kernel: "pi" | "dsh") => neutralStore.put({
      ...emptyNeutralSession(ns, { kernel, cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z" }),
      lineages: [{ lineageId: ns, fork: null, entries: [{ neutralEntryId: `${ns}:0`, message: { role: "user", content: `hi-${ns}` } }] }],
    });
    make("ns-A", "pi"); make("ns-B", "dsh"); make("ns-C", "pi");
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir })), dshSource]);
    const created: string[] = [];
    const factory: BackendFactory = {
      seed: async () => null,
      create: (opts) => { created.push(opts.kernel); return new TriBackend(opts.kernel as "pi" | "dsh") as unknown as BaseBackend; },
    };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, catalog);
    // 逐个会话发一轮,再回来切换重发
    const send = async (ns: string, kernel: "pi" | "dsh", text: string) => {
      s.setContext(CWD, ns);
      const model = kernel === "pi" ? { provider: "p", modelId: "a", kernel: "pi" as const, thinkingLevel: "" } : { provider: "us-new", modelId: "dsh-model", kernel: "dsh" as const, thinkingLevel: "" };
      await s.setModel(model.provider, model.modelId, kernel);
      await s.prompt(text, undefined, undefined, model);
    };
    await send("ns-A", "pi", "A1");
    await send("ns-B", "dsh", "B1");
    await send("ns-C", "pi", "C1");
    // 切回 A/B/C 重发(第二轮)——修前第三会话后切回撞「已固定内核」
    await send("ns-A", "pi", "A2");
    await send("ns-B", "dsh", "B2");
    await send("ns-C", "pi", "C2");
    // 三会话各自有进程(pi×2 + dsh×1),不串
    expect(created.filter((k) => k === "pi")).toHaveLength(2);
    expect(created.filter((k) => k === "dsh")).toHaveLength(1);
    // 无异常即通过(核心:第二轮 setModel 不撞跨内核闸)
  });
});

describe("fork/clone 派生会话首发物化(内核私有 id 派生自新会话根 lineageId,§12.2 + unify §6.5)", () => {
  class LineageBackend {
    alive = false;
    capabilities = { pi: { onBusFrame: () => {}, onQuestion: () => {}, onExit: null, stderr: "", resync: async () => ({ messages: [], state: { isStreaming: false }, tree: { rootId: "", lineages: [] } }) }, fileBacked: true }; // 有 pi 面 + 文件态 → 走预 seed 重 spawn 路径
    calls: string[] = [];
    async start(): Promise<void> { this.alive = true; }
    async stop(): Promise<void> { this.alive = false; }
    onEvent(): () => void { return () => {}; }
    async sendMessage(): Promise<void> { this.calls.push("sendMessage"); }
    async setModel(): Promise<void> {}
    async setSessionName(): Promise<void> {}
    async seed(): Promise<string> { this.calls.push("seed"); return "seeded"; }
    async fork(): Promise<unknown> { return { lineageId: "f", sessionReplaced: false }; }
    async getTree(): Promise<LineageTree> { return { rootId: "", lineages: [] }; }
    async getEntries(): Promise<NeutralMessage[]> { return []; }
    async bookmark(): Promise<Anchor> { return { lineageId: "", entryId: "" }; }
    async deleteBookmark(): Promise<void> {}
    async abort(): Promise<void> {}
  }

  function newLineageForkStore(seedImpl?: (calls: number) => Promise<string>): {
    s: SessionStore; neutralStore: NeutralSessionStore; ns: string; sessionPath: string;
    createdLineageIds: (string | undefined)[];
  } {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "fork-lineageid-")));
    const ns = "ns-lineageid";
    neutralStore.put({
      ...emptyNeutralSession(ns, { kernel: "pi", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z" }),
      lineages: [
        { lineageId: ns, fork: null, entries: [{ neutralEntryId: `${ns}:0`, message: { role: "user", content: "base" } }] },
      ],
    });
    const createdLineageIds: (string | undefined)[] = [];
    let seedCalls = 0;
    const factory: BackendFactory = {
      seed: async () => { seedCalls++; return seedImpl ? seedImpl(seedCalls) : "seeded-path"; },
      create: (opts) => { createdLineageIds.push(opts.lineageId); return new LineageBackend() as unknown as BaseBackend; },
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]);
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, catalog);
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    return { s, neutralStore, ns, sessionPath, createdLineageIds };
  }

  it("fork 派生会话首发物化:factory.create 收到 lineageId=新会话根(不写源会话文件),pendingSeed 物化后清除", async () => {
    const { s, neutralStore, ns, sessionPath, createdLineageIds } = newLineageForkStore();
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath, undefined, false, "pi", "p", "a"); // 带模型起,避免 prompt setModel 重起进程重置活跃 lineage
    const newPath = await s.fork(ns, `${ns}:0`); // 派生新会话 + 切激活(惰性,不发请求)
    const newNs = basename(newPath, ".jsonl");
    // 派生即见:新会话在中立层,根 lineageId ≡ newNs;pendingSeed 置位(内核侧未物化)
    const derived = neutralStore.get(newNs)!;
    expect(derived.lineages.find((l) => l.fork === null)?.lineageId).toBe(newNs);
    expect(derived.header.pendingSeed).toBe(true);
    await s.prompt("branch-first", undefined, undefined, { provider: "p", modelId: "a", kernel: "pi" as const, thinkingLevel: "" });
    // 物化重 spawn 的 create 必须带 lineageId=newNs(派生自己的文件,不写源会话的根文件);
    // 源会话 ns 绝不出现在任何 create 的 lineageId 上(文件对应不漂移)
    expect(createdLineageIds.some((id) => id === newNs)).toBe(true);
    expect(createdLineageIds.some((id) => id === ns)).toBe(false);
    // §6.5:物化成功(拿到内核认同)→ pendingSeed 清除
    expect(neutralStore.get(newNs)!.header.pendingSeed).toBeUndefined();
  });

  it("物化失败:错误上抛 + pendingSeed 保持,下次首发自动重试(§6.5 崩溃安全)", async () => {
    // 第一次 seed 被内核拒绝,第二次成功
    const { s, neutralStore, ns, sessionPath } = newLineageForkStore(async (calls) => {
      if (calls === 1) throw new Error("seed 被拒绝");
      return "seeded-path";
    });
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath, undefined, false, "pi", "p", "a");
    const newPath = await s.fork(ns, `${ns}:0`);
    const newNs = basename(newPath, ".jsonl");
    // 首发:seed 失败 → 错误原文上抛(用户可见),pendingSeed 保持
    await expect(s.prompt("branch-first", undefined, undefined, { provider: "p", modelId: "a", kernel: "pi" as const, thinkingLevel: "" }))
      .rejects.toThrow("seed 被拒绝");
    expect(neutralStore.get(newNs)!.header.pendingSeed).toBe(true);
    // 重试:pendingSeed 仍在 → 首发仍强制物化 → 第二次 seed 成功 → 标记清除
    await s.prompt("branch-first", undefined, undefined, { provider: "p", modelId: "a", kernel: "pi" as const, thinkingLevel: "" });
    expect(neutralStore.get(newNs)!.header.pendingSeed).toBeUndefined();
  });

  it("clone 产物同样强制物化(根因守卫:克隆前缀进新内核文件,不拿空文件起进程)", async () => {
    // 根因:clone 派生的新会话内核文件尚不存在,而 createProc 曾按 capabilities.extensions 把
    // materializedLineageId 标成 ns(已物化)→ materializeActiveLineage 提前 return →
    // pi 拿不存在的 <newNs>.jsonl 起空会话,克隆内容永不进内核。pendingSeed(§6.5)是修复载体。
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "clone-seed-")));
    const ns = "ns-clone";
    neutralStore.put({
      ...emptyNeutralSession(ns, { kernel: "pi", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z" }),
      lineages: [{ lineageId: ns, fork: null, entries: [{ neutralEntryId: `${ns}:0`, message: { role: "user", content: "base" } }] }],
    });
    const seededTexts: string[][] = [];
    const createdLineageIds: (string | undefined)[] = [];
    const factory: BackendFactory = {
      seed: async (lineage) => {
        seededTexts.push((lineage as { message: { content: unknown } }[]).map((e) => String(e.message.content)));
        return "seeded-path";
      },
      create: (opts) => { createdLineageIds.push(opts.lineageId); return new LineageBackend() as unknown as BaseBackend; },
    };
    const catalog = new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]);
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, catalog);
    const sessionPath = join(dir, "sessions", cwdToBucketName(CWD), `${ns}.jsonl`);
    s.setContext(CWD, sessionPath);
    await s.start(CWD, sessionPath, undefined, false, "pi", "p", "a");
    await s.clone(); // 派生整树副本 + 切激活(pendingSeed 置位)
    const newNs = (s as unknown as { activeSessionPath: string }).activeSessionPath;
    const cloneNs = basename(newNs, ".jsonl");
    expect(neutralStore.get(cloneNs)?.header.pendingSeed).toBe(true);
    await s.prompt("clone-first", undefined, undefined, { provider: "p", modelId: "a", kernel: "pi" as const, thinkingLevel: "" });
    // 克隆前缀 seed 进新文件(create 带 lineageId=克隆会话根),内容含 base
    expect(createdLineageIds.some((id) => id === cloneNs)).toBe(true);
    expect(seededTexts.some((texts) => texts.includes("base"))).toBe(true);
    expect(neutralStore.get(cloneNs)?.header.pendingSeed).toBeUndefined();
  });
});

describe("能力面广播(§7.6 push 收口:打开/新建、首发送锁定、总线不锁)", () => {
  const collectCaps = (): { seen: Array<{ kernel?: string | null; locked?: boolean }>; off: () => void } => {
    const seen: Array<{ kernel?: string | null; locked?: boolean }> = [];
    const off = store.onKernelEvent((e) => {
      if (e.kind === "capabilitiesChanged") seen.push(e.capabilities as { kernel?: string | null; locked?: boolean });
    });
    return { seen, off };
  };

  it("setContext 打开/新建会话 → 广播一次能力面(渲染层不滞留上一会话的锁定)", () => {
    const { seen, off } = collectCaps();
    try {
      // 新建会话壳:无进程、无历史 → locked=false 必须广播出去(此前无推送,渲染层滞留)
      store.setContext(CWD, null);
      expect(seen.length).toBe(1);
      expect(seen[0]?.locked).toBe(false);
      // 切回有活进程的会话 → 再广播一次,带该会话实况
      store.setContext(CWD, sessionPath);
      expect(seen.length).toBe(2);
      expect(seen[1]?.kernel).toBe("pi");
    } finally {
      off();
    }
  });

  it("首发送锁定:首个 prompt 落内容后 locked 转真(边沿一次),第二条不重复广播", async () => {
    const { seen, off } = collectCaps();
    try {
      await store.prompt("第一条");
      const lockedTrue = seen.filter((c) => c.locked === true);
      expect(lockedTrue.length).toBe(1); // markTouched 边沿广播
      await store.prompt("第二条");
      expect(seen.filter((c) => c.locked === true).length).toBe(1); // 不重复广播
    } finally {
      off();
    }
  });

  it("总线协议流量不锁会话:sendPromptTo 不置 touched(locked 保持 false)", async () => {
    // 实弹根因:pi spawn 时 fit-pi-extension 的 bus ping 应答经 sendPromptTo 置 touched,
    // 没发过消息的会话被误锁内核(新会话模型下拉 dsh TAB 锁死)。
    await store.sendPromptTo(sessionPath, "{\"$bus\":true,\"kind\":\"bus_response\"}", "steer");
    expect(store.getCapabilities().locked).toBe(false);
    // 对照:用户真实发送后 locked 转真
    await store.prompt("用户真发");
    expect(store.getCapabilities().locked).toBe(true);
  });
});

describe("SessionStore.getTree 中立层投影(逐条明细树换中立层投影 ee0798d1 的格式对应守卫)", () => {
  it("双 lineage(根 + 分叉)→ LineageTree:id 映射 + fork.boundaryEntryId→boundary 字段翻译", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "gettree-neutral-")));
    const ns = "ns-gettree";
    const forkNs = "ns-gettree-fork";
    neutralStore.put({
      ...emptyNeutralSession(ns, { kernel: "pi", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z" }),
      lineages: [
        { lineageId: ns, fork: null, entries: [{ neutralEntryId: `${ns}:0`, message: { role: "user", content: "hi" } }] },
        { lineageId: forkNs, fork: { parentLineageId: ns, boundaryEntryId: `${ns}:0` }, entries: [{ neutralEntryId: `${forkNs}:0`, message: { role: "user", content: "forked" } }] },
      ],
    });
    // getTree 中立层命中时不走 backend(catalog.getTree 兜底只在中立层缺失时),dummy 工厂即可
    const dummyFactory: BackendFactory = { create: () => ({} as unknown as BaseBackend) };
    const s = new SessionStore(dummyFactory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    const tree: LineageTree = await s.getTree(ns);
    expect(tree.rootId).toBe(ns);
    expect(tree.lineages).toHaveLength(2);
    const root = tree.lineages.find((l) => l.id === ns)!;
    const fork = tree.lineages.find((l) => l.id === forkNs)!;
    expect(root.fork).toBeNull();
    // 格式对应关键点:中立层 fork.boundaryEntryId → LineageTree fork.boundary(BoundaryRef)
    expect(fork.fork).toEqual({ parentLineageId: ns, boundary: `${ns}:0` });
  });
});

describe("activeSessionHasHistory 的 pendingSeed 豁免(fork→跨内核切 dsh 根因守卫)", () => {
  it("pendingSeed=true 的派生会话不算历史:fork 后可切目标内核(不锁死源内核)", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "pendingseed-neutral-")));
    const ns = "ns-pendingseed";
    // 派生会话:有 prefix entries + pendingSeed=true(未物化)
    neutralStore.put({
      ...emptyNeutralSession(ns, { kernel: "pi", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z" }),
      header: { kernel: "pi", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z", pendingSeed: true, derivedFrom: { kind: "fork", sourceNeutralSessionId: "src", boundaryEntryId: "src:1" } },
      lineages: [{ lineageId: ns, fork: null, entries: [{ neutralEntryId: `${ns}:0`, message: { role: "user", content: "prefix" } }] }],
    });
    const dummyFactory: BackendFactory = { create: () => ({} as unknown as BaseBackend) };
    const s = new SessionStore(dummyFactory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    s.setContext(CWD, ns);
    // pendingSeed=true → 不算历史 → 不锁(可自由选内核)
    expect(s.getCapabilities().locked).toBe(false);
    // 对照:物化后(pendingSeed 清除)→ 算历史 → 锁
    neutralStore.putHeader(ns, { ...neutralStore.get(ns)!.header, pendingSeed: false });
    s.setContext(CWD, ns);
    expect(s.getCapabilities().locked).toBe(true);
  });
});

describe("fork dsh → 切 pi 的 header.kernel 更新(reverse 方向,r24 待查项根因)", () => {
  it("writeNeutralModelPrefs 在 setModel 应把 header.kernel 从 dsh 改 pi", async () => {
    const neutralStore = new NeutralSessionStore(mkdtempSync(join(tmpdir(), "reverse-kernel-neutral-")));
    const ns = "ns-dsh-fork";
    neutralStore.put({
      ...emptyNeutralSession(ns, { kernel: "dsh", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z" }),
      header: { kernel: "dsh", cwd: CWD, createdAt: "2026-09-04T00:00:00.000Z", pendingSeed: true, derivedFrom: { kind: "fork", sourceNeutralSessionId: "src", boundaryEntryId: "src:1" } },
      lineages: [{ lineageId: ns, fork: null, entries: [{ neutralEntryId: `${ns}:0`, message: { role: "user", content: "prefix" } }] }],
    });
    const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
    const s = new SessionStore(factory, catalogFactory, dir, undefined, neutralStore, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));
    s.setContext(CWD, ns); // dsh 投影路径 = ns
    // setModel(pi) 应触发 writeNeutralModelPrefs(kernel=pi)
    await s.setModel("p", "a", "pi");
    const headerAfter = neutralStore.getHeader(ns)!.header;
    expect(headerAfter.kernel).toBe("pi");
  });
});
