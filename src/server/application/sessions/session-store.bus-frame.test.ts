// sendPromptTo 的内核无关守卫 —— 修的是「dsh 会话静默收不到任何 bus 帧」。
//
// 根因(勿回退):sendPromptTo 曾无条件走 `this.asPi(proc).sendMessage(text, undefined, streamingBehavior)`,
// 而 asPi 在 backend 无 capabilities.extensions 时抛「当前后端不支持 pi 专属命令」。
// 调用方是 bus 的 deliver(session-bus.ts),它把这个错误 catch 成静默失败并解释为「目标已死」——
// 于是 dsh 会话收不到房间消息/任务注入/bus_response,且日志里与「进程真的死了」无法区分。
// 这是 CLAUDE.md §1.5 明禁的唯一状态(静默缺面)。
// 详见 docs/design/bus-notification-defects-and-stats-handoff.md 缺陷 C。
//
// 修法:能力探测——有扩展面则带 streamingBehavior(保住 pi 的 steer/followUp 档位语义),
// 没有则走契约里的中性 sendMessage(BaseBackend 的必实现意图之一,每个内核都有)。
//
// 后端用最小 plain object 替身:不 mock sendPromptTo 本身(被测的就是它),
// 只替它必然会碰到的那两面(capabilities / sendMessage)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type BackendFactory } from "./session-store";
import { PiSessionCatalog } from "../../kernel/pi/backend/pi-catalog";
import { cwdToBucketName } from "@my-harness-desktop/shared";
import type { SessionCatalogFactory, KernelId, BaseBackend } from "@my-harness-desktop/shared";

const CWD = "/tmp/proj-bus-frame";

interface FakeCalls {
  /** 中性 sendMessage 的调用记录(契约面,两内核都有)。 */
  neutral: string[];
  /** 扩展面 sendMessage 的调用记录(仅 pi 形态存在)。 */
  ext: { text: string; behavior?: string }[];
}

/** 造一个最小后端替身。withExtensions=false 模拟 dsh 形态(无 pi 扩展面)。 */
function fakeBackend(kernel: KernelId, withExtensions: boolean, calls: FakeCalls): BaseBackend {
  const base = {
    kernel,
    alive: false,
    sessionId: "s1",
    capabilities: {},
    configDepPaths: [],
    async start(): Promise<void> { this.alive = true; },
    async stop(): Promise<void> { this.alive = false; },
    onEvent(): () => void { return () => {}; },
    onProcessExit(): void {},
    async sendMessage(text: string): Promise<void> { calls.neutral.push(text); },
    async abort(): Promise<void> {},
    async setModel(): Promise<void> {},
    async setSessionName(): Promise<void> {},
    async getTree(): Promise<unknown> { return { rootId: "r", lineages: [] }; },
    async getEntries(): Promise<unknown[]> { return []; },
    bookmark(): unknown { return { lineageId: "", entryId: "" }; },
    deleteBookmark(): void {},
    async seed(): Promise<string> { return ""; },
  };
  if (!withExtensions) return base as unknown as BaseBackend;
  return {
    ...base,
    capabilities: {
      extensions: {
        sendMessage: async (text: string, _images?: unknown, streamingBehavior?: string): Promise<void> => {
          calls.ext.push({ text, behavior: streamingBehavior });
        },
        // bindProcEvents 会给扩展面挂两条通道;sync 会调 resync 拿快照。本测试不驱动它们,给最小实现。
        onBusFrame: (): (() => void) => () => {},
        onQuestion: (): (() => void) => () => {},
        resync: async (): Promise<unknown> => ({
          state: { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, sessionId: "s1", messageCount: 0, pendingMessageCount: 0 },
          entries: [], messages: [], tree: [], commands: [], leafId: null,
        }),
      },
    },
  } as unknown as BaseBackend;
}

let dir: string;
let sessionPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bus-frame-"));
  const bucket = join(dir, "sessions", cwdToBucketName(CWD));
  mkdirSync(bucket, { recursive: true });
  sessionPath = join(bucket, "s1.jsonl");
  writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s1", cwd: CWD }) + "\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 建单一内核的 store 并起进程。 */
async function boot(kernel: KernelId, withExtensions: boolean): Promise<{ store: SessionStore; calls: FakeCalls }> {
  const calls: FakeCalls = { neutral: [], ext: [] };
  const factory: BackendFactory = {
    create: () => fakeBackend(kernel, withExtensions, calls),
    seed: async () => null,
  };
  const catalogFactory: SessionCatalogFactory = { create: () => new PiSessionCatalog(dir) };
  const store = new SessionStore(factory, catalogFactory, { sessionRoots: [join(dir, "sessions")], ids: [kernel] });
  store.setContext(CWD, sessionPath);
  await store.start(CWD, sessionPath, undefined, false, kernel);
  return { store, calls };
}

describe("sendPromptTo 内核无关(缺陷 C 守卫)", () => {
  it("无扩展面的后端(dsh 形态):走中性 sendMessage,不抛「不支持 pi 专属命令」", async () => {
    const { store, calls } = await boot("dsh", false);

    // 关键回归:此前这里抛「当前后端不支持 pi 专属命令」,被 bus 的 deliver 静默吞掉,
    // 症状是 dsh 会话收不到任何 bus 帧。
    await expect(store.sendPromptTo(sessionPath, '{"$bus":true,"kind":"chat"}', "followUp"))
      .resolves.toBeUndefined();

    expect(calls.neutral).toEqual(['{"$bus":true,"kind":"chat"}']);
    expect(calls.ext).toEqual([]);
  });

  it("有扩展面的后端(pi 形态):仍带 streamingBehavior 走扩展面(档位语义不退化)", async () => {
    const { store, calls } = await boot("pi", true);

    await store.sendPromptTo(sessionPath, '{"$bus":true,"kind":"bus_response"}', "steer");

    expect(calls.ext).toEqual([{ text: '{"$bus":true,"kind":"bus_response"}', behavior: "steer" }]);
    expect(calls.neutral).toEqual([]);
  });

  it("会话不在线:仍抛「会话不在线」——bus 据此区分合法态与真缺陷", async () => {
    const factory: BackendFactory = { create: () => fakeBackend("dsh", false, { neutral: [], ext: [] }), seed: async () => null };
    const catalogFactory: SessionCatalogFactory = { create: () => new PiSessionCatalog(dir) };
    const store = new SessionStore(factory, catalogFactory, { sessionRoots: [join(dir, "sessions")], ids: ["dsh"] });
    store.setContext(CWD, sessionPath);
    // 不 start:进程不在场。这个错误必须可分辨,不能被 deliver 的 catch 归成同一类。
    await expect(store.sendPromptTo(sessionPath, "{}", "followUp")).rejects.toThrow(/会话不在线/);
  });
});
