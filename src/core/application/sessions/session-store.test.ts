// SessionStore 差量执行裸单测(docs/design/session-model-config.md §4.3):
// setModel/setThinkingLevel 经 ensureForSend 拿到实证快照后,进程已持目标值即跳过 RPC
// (同值 set_model 会在时间线落 model_change 分隔线);实况有差或快照缺失才发。
// fixture:tmp 目录真会话文件(updateSessionHeader 要求头行真实存在);FakeAdapter
// 记录发出的命令 type,不 mock 框架。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type RpcAdapterFactory } from "./session-store";
import { cwdToBucketName } from "../../domain/sessions";
import type { RpcAdapter } from "../../../client/pi/rpc-adapter";
import type { RpcCommand } from "../../protocol/rpc-types";

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
  const factory: RpcAdapterFactory = { create: () => adapter as unknown as RpcAdapter };
  store = new SessionStore(factory, dir);
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
