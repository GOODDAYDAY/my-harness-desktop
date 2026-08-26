// 会话级身份(role = system prompt)注入 + 多轮编排对话测试。
//
// 验证目标(需求:主 session 就是编排器,长对话多轮,自定义初始上下文):
// 1. spawnSession(cwd, {role}) 把角色卡文本内联作 --append-system-prompt 的值注入 argv——
//    底座 resolvePromptInput 对非文件路径参数当文本本身,故 role 不落文件、不碰会话头行。
// 2. 多轮编排对话:编排器(主 session,role=编排器)经 opSessionCreate 派执行器(role=执行器),
//    执行器 agentSettled → session_done 携带完整输出回流编排器;两轮往返,轮轮闭环。
//
// FakeAdapter 记录 spawn argv 与已发命令;事件经 emitSettled() 手动触发 agent_settled。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type BackendFactory } from "./session-store";
import { PiBackend } from "../../../client/pi/pi-backend";
import { piDerivedSessionPath } from "../../../client/pi/pi-catalog";
import type { SessionCatalogFactory } from "@my-harness-desktop/shared";
import { SessionBus } from "./session-bus";
import { cwdToBucketName, roleToPrompt, type SessionRole } from "@my-harness-desktop/shared";
import type { RpcAdapter } from "../../../client/pi/rpc-adapter";
import type { RpcCommand } from "../../protocol/rpc-types";

/** 目录/CRUD 工厂桩:本测试只测角色卡注入,不碰目录。newSessionId 返回唯一 id(多会话并行需不撞 key)。 */
let newSessionSeq = 0;
const catalogFactory: SessionCatalogFactory = {
  create: () => ({
    kernel: "pi" as const,
    list: async () => [],
    open: async () => null,
    rename: async () => {},
    updateHeader: async () => {},
    deleteSessions: async () => {},
    copy: async () => {},
    readToolConfig: async () => null,
    readCustom: async () => ({ kernel: "pi" }),
    getTree: async () => ({ rootId: "", lineages: [] }),
    bookmark: (_cwd: string, lineageId: string, boundary: string) => ({ lineageId, entryId: boundary }),
    deleteBookmark: () => {},
    contextProbeTokens: () => null,
    newSessionId: () => piDerivedSessionPath(dir, CWD, `new-session-${newSessionSeq++}`),
    projectionPath: (_cwd: string, lineageId: string) => piDerivedSessionPath(dir, CWD, lineageId),
    projectStats: async () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, sessionCount: 0, turns: 0 }),
  }),
};

const CWD = "/tmp/proj";

const ORCHESTRATOR_ROLE: SessionRole = {
  name: "编排器",
  persona: "你是任务编排器,负责把用户目标拆解成子任务、派发给执行器、收集结果并综合汇报。",
  goal: "把「重构 auth 模块」拆解并派发,综合执行器的结果。",
  constraints: "不亲自写代码,只拆解、派发、综合。",
};

const EXECUTOR_ROLE: SessionRole = {
  name: "执行器",
  persona: "你是代码执行器,专注完成交给你的单个子任务。",
  goal: "完成派发的子任务并返回结果。",
};

/** get_state 固定实况(spawn waitReady 探测用)。 */
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
  /** spawn argv(createProc 拼的,含 --session 与 --append-system-prompt)。 */
  args: string[] = [];
  /** 已发命令 type 序列。 */
  sent: string[] = [];
  /** prompt 命令的 message 文本(首条 task 与 session_done 帧注入都走 prompt)。 */
  promptTexts: string[] = [];
  /** get_last_assistant_text 的返回文本(settle 输出采集主源)。 */
  lastAssistantText = "";
  private eventCb: ((e: { type: string; [k: string]: unknown }) => void) | null = null;

  async start(): Promise<void> { this.alive = true; }
  async stop(): Promise<void> { this.alive = false; }
  onEvent(cb: (e: { type: string; [k: string]: unknown }) => void): void { this.eventCb = cb; }
  onBusFrame(): void {}
  onExtensionUI(): void {}
  async send(command: RpcCommand): Promise<unknown> {
    this.sent.push(command.type);
    switch (command.type) {
      case "prompt":
        this.promptTexts.push((command as { message?: string }).message ?? "");
        return { success: true, data: {} };
      case "get_state":
        return { success: true, data: { ...PROC_STATE } };
      case "get_entries":
        return { success: true, data: { entries: [], leafId: null } };
      case "get_tree":
        return { success: true, data: { tree: [], leafId: null } };
      case "get_commands":
        return { success: true, data: { commands: [] } };
      case "get_last_assistant_text":
        return { success: true, data: { text: this.lastAssistantText } };
      default:
        return { success: true, data: {} };
    }
  }
  /** 模拟底座 agent 完成(agent_settled 事件 → settleSession → session_done 回流)。 */
  emitSettled(): void {
    this.eventCb?.({ type: "agent_settled" });
  }
  /** 模拟会话发言(message_end → autoFan → 房间成员收到 chat 帧)。 */
  emitMessageEnd(text: string, role: "assistant" | "user" = "assistant"): void {
    this.eventCb?.({ type: "message_end", message: { role, content: text } });
  }
}

let dir: string;
let adapters: FakeAdapter[];
let globalPrompt: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-role-"));
  const bucket = join(dir, "sessions", cwdToBucketName(CWD));
  mkdirSync(bucket, { recursive: true });
  // 全局 system prompt 文件(所有会话共享的"底")
  globalPrompt = join(dir, "global.md");
  writeFileSync(globalPrompt, "# 全局工程原则\n");
  adapters = [];
  const factory: BackendFactory = {
    create: (opts) => {
      const a = new FakeAdapter();
      // 模拟 createPiBackend 的中性字段 → spawn argv 翻译(生产逻辑在 bootstrap/kernel)。
      const args: string[] = [];
      if (opts.neutralSessionId) args.push("--session", piDerivedSessionPath(opts.agentDir, opts.cwd, opts.neutralSessionId));
      for (const p of opts.systemPromptPaths ?? []) args.push("--append-system-prompt", p);
      for (const t of opts.systemPromptTexts ?? []) args.push("--append-system-prompt", t);
      a.args = args;
      adapters.push(a);
      return new PiBackend(a as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir });
    },
  };
  store = new SessionStore(factory, catalogFactory, dir, () => [globalPrompt]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("会话级身份(role = system prompt)注入", () => {
  it("role 文本内联作 --append-system-prompt 的值,不落文件、不碰头行", async () => {
    const { sessionPath, key } = await store.spawnSession(CWD, { role: ORCHESTRATOR_ROLE });
    const adapter = adapters.find((a) => a.args.includes(sessionPath));
    expect(adapter).toBeTruthy();
    // argv 里直接含 roleToPrompt 的文本(非文件路径)
    expect(adapter!.args).toContain(roleToPrompt(ORCHESTRATOR_ROLE));
    // 全局 system prompt 路径仍在(两层叠加:全局底 + 会话角色)
    expect(adapter!.args).toContain(globalPrompt);
    // 磁盘上无伴生 role 文件(role 是进程参数,不是文件,也不是会话数据)
    expect(existsSync(`${sessionPath}.role.md`)).toBe(false);
    expect(key).toMatch(/^bus:/);
  });
});

describe("编排(主 session 即编排器,多执行器并行 fan-out)", () => {
  it("一次并行派 3 个执行器,各自结果回流,编排器收集全部", async () => {
    const sink = { broadcast: vi.fn() };
    const bus = new SessionBus(store, sink);
    store.onAnySessionEvent((event, sessionKey) => bus.onSessionEvent(event, sessionKey));

    // 主 session 就是编排器:用户主会话经 setContext + start 注入编排器角色(真实主会话路径)
    const mainSessionPath = join(dir, "sessions", cwdToBucketName(CWD), "main.jsonl");
    writeFileSync(mainSessionPath, JSON.stringify({ type: "session", id: "main", cwd: CWD, "custom-my-harness-desktop": { kernel: "pi" } }) + "\n");
    store.setContext(CWD, mainSessionPath);
    await store.start(CWD, mainSessionPath, ORCHESTRATOR_ROLE);
    const orchAddr = `session:${mainSessionPath}`;
    const orchAdapter = adapters.find((a) => a.args.includes(mainSessionPath));
    expect(orchAdapter!.args).toContain(roleToPrompt(ORCHESTRATOR_ROLE));

    // 一次并行派 3 个执行器(多执行器 fan-out)
    const tasks = ["任务1:拆 auth.ts", "任务2:补测试", "任务3:跑集成"];
    const subs = await Promise.all(
      tasks.map((task) =>
        bus.opSessionCreate(orchAddr, { role: EXECUTOR_ROLE, task, watch: true }) as Promise<{
          session: string; key: string; sessionPath: string;
        }>,
      ),
    );
    // 每个执行器都拿到执行器角色 + 各自任务
    subs.forEach((sub, i) => {
      const a = adapters.find((x) => x.args.includes(sub.sessionPath))!;
      expect(a.args).toContain(roleToPrompt(EXECUTOR_ROLE));
      expect(a.promptTexts).toContain(tasks[i]);
    });

    // 3 个执行器并行干活,各自完成 → 各自结果回流编排器
    const results = ["已拆成 3 个文件", "已补 12 个测试", "集成全绿"];
    subs.forEach((sub, i) => {
      const a = adapters.find((x) => x.args.includes(sub.sessionPath))!;
      a.lastAssistantText = results[i];
      a.emitSettled();
    });
    await sleep(30);

    // 编排器收集到全部 3 个结果(多执行器多路回流)
    results.forEach((r) => {
      expect(orchAdapter!.promptTexts.some((t) => t.includes(r))).toBe(true);
    });
  });
});

// ============ 四种协作场景:拉起角色(role)+ 事件通信 + 多轮往返 ============
// 本质(需求拍板):拉起 pi + 设系统上下文(role)+ 靠事件通信。四场景差异只在角色卡与拓扑,
// 机制同一条:spawn/start(role) + 房间 fan / session_done / reopen。

const HOST_ROLE: SessionRole = {
  name: "主持人", persona: "你是海龟汤主持人。",
  constraints: "只能回答 是/否/无关,绝不直接公布谜底。",
  knowledge: "谜底是:雨伞。",
};
const PLAYER_ROLE: SessionRole = { name: "玩家", persona: "你是猜谜玩家。", goal: "通过提问猜出谜底。" };
const WOLF_ROLE: SessionRole = { name: "狼人", persona: "你是狼人,隐藏身份。", knowledge: "你是狼人,村民是好人。" };
const VILLAGER_ROLE: SessionRole = { name: "村民", persona: "你是村民,找出狼人。" };
const SEER_ROLE: SessionRole = { name: "预言家", persona: "你是预言家,每晚查一人身份。" };

function makeBus(): SessionBus {
  const sink = { broadcast: vi.fn() };
  const bus = new SessionBus(store, sink);
  store.onAnySessionEvent((event, sessionKey) => bus.onSessionEvent(event, sessionKey));
  return bus;
}

function adapterOf(sessionPath: string): FakeAdapter {
  return adapters.find((a) => a.args.includes(sessionPath))!;
}

describe("场景 1:海龟汤(主持人 + 玩家,房间问答多轮)", () => {
  it("玩家提问 → 主持人只答是/否 → 再问再答,轮轮闭环", async () => {
    const bus = makeBus();
    const host = await store.spawnSession(CWD, { role: HOST_ROLE });
    const player = await store.spawnSession(CWD, { role: PLAYER_ROLE });
    expect(adapterOf(host.sessionPath).args).toContain(roleToPrompt(HOST_ROLE));
    expect(adapterOf(player.sessionPath).args).toContain(roleToPrompt(PLAYER_ROLE));
    // 进同一房间(说话即传输)
    bus.opChannelJoin("turtle-soup", `session:${host.key}`);
    bus.opChannelJoin("turtle-soup", `session:${player.key}`);

    // 第一轮:玩家提问 → fan 给主持人;主持人答 → fan 回玩家
    adapterOf(player.sessionPath).emitMessageEnd("谜底是动物吗?");
    await sleep(30);
    expect(adapterOf(host.sessionPath).promptTexts.some((t) => t.includes("谜底是动物吗"))).toBe(true);
    adapterOf(host.sessionPath).emitMessageEnd("否");
    await sleep(30);
    expect(adapterOf(player.sessionPath).promptTexts.some((t) => t.includes("否"))).toBe(true);

    // 第二轮:再问再答
    adapterOf(player.sessionPath).emitMessageEnd("谜底是雨伞吗?");
    await sleep(30);
    expect(adapterOf(host.sessionPath).promptTexts.some((t) => t.includes("谜底是雨伞吗"))).toBe(true);
    adapterOf(host.sessionPath).emitMessageEnd("是");
    await sleep(30);
    expect(adapterOf(player.sessionPath).promptTexts.some((t) => t.includes("是"))).toBe(true);
  });
});

describe("场景 2:狼人杀(多角色房间,多轮次逐个发言)", () => {
  it("三轮讨论,每轮狼人/村民/预言家逐个发言,互相听见", async () => {
    const bus = makeBus();
    const wolf = await store.spawnSession(CWD, { role: WOLF_ROLE });
    const villager = await store.spawnSession(CWD, { role: VILLAGER_ROLE });
    const seer = await store.spawnSession(CWD, { role: SEER_ROLE });
    bus.opChannelJoin("village", `session:${wolf.key}`);
    bus.opChannelJoin("village", `session:${villager.key}`);
    bus.opChannelJoin("village", `session:${seer.key}`);

    // 三轮发言:每轮狼人 → 村民 → 预言家 逐个说(发言阶段逐个答的感觉)
    const rounds = [
      ["我怀疑预言家是狼", "我是村民,别被狼带偏", "我昨晚查了狼人"],
      ["预言家在说谎", "投狼人出局", "我有证据,狼人就是他"],
      ["你们都被骗了", "狼人已经慌了", "今晚我查村民"],
    ];
    for (const [wolfSay, villagerSay, seerSay] of rounds) {
      adapterOf(wolf.sessionPath).emitMessageEnd(wolfSay);
      adapterOf(villager.sessionPath).emitMessageEnd(villagerSay);
      adapterOf(seer.sessionPath).emitMessageEnd(seerSay);
      await sleep(20);
    }

    // 第一轮逐个发言:每个发言都被其他两人听见,发言者自己除外(防回声)
    expect(adapterOf(villager.sessionPath).promptTexts.some((t) => t.includes("我怀疑预言家是狼"))).toBe(true);
    expect(adapterOf(seer.sessionPath).promptTexts.some((t) => t.includes("我怀疑预言家是狼"))).toBe(true);
    expect(adapterOf(wolf.sessionPath).promptTexts.some((t) => t.includes("我怀疑预言家是狼"))).toBe(false);
    expect(adapterOf(wolf.sessionPath).promptTexts.some((t) => t.includes("我是村民,别被狼带偏"))).toBe(true);
    expect(adapterOf(seer.sessionPath).promptTexts.some((t) => t.includes("我是村民,别被狼带偏"))).toBe(true);
    expect(adapterOf(villager.sessionPath).promptTexts.some((t) => t.includes("我是村民,别被狼带偏"))).toBe(false);
    // 第三轮发言仍送达(多轮次持续,非一次性)
    expect(adapterOf(villager.sessionPath).promptTexts.some((t) => t.includes("你们都被骗了"))).toBe(true);
    expect(adapterOf(wolf.sessionPath).promptTexts.some((t) => t.includes("今晚我查村民"))).toBe(true);
  });
});

describe("场景 4:一次性执行(执行器完成后 reopen 续聊)", () => {
  it("执行器跑完 → reopen 续聊带角色 → 继续对话", async () => {
    makeBus();
    const exec = await store.spawnSession(CWD, { role: EXECUTOR_ROLE });
    expect(adapterOf(exec.sessionPath).args).toContain(roleToPrompt(EXECUTOR_ROLE));
    // 干活完成
    adapterOf(exec.sessionPath).emitSettled();
    await sleep(10);
    // reopen 续聊(带角色)→ 新进程注入同一 role
    const reopened = await store.reopenSession(CWD, exec.sessionPath, EXECUTOR_ROLE);
    const reopenedAdapter = adapters[adapters.length - 1]; // reopen 新建的进程
    expect(reopenedAdapter.args).toContain(roleToPrompt(EXECUTOR_ROLE));
    // 继续对话:发消息 → 收到(多轮不是一次性)
    await store.sendPromptTo(reopened.key, "上次的结果再优化一下");
    expect(reopenedAdapter.promptTexts).toContain("上次的结果再优化一下");
  });
});
