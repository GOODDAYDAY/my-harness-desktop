// GoalDriver 集成测试(壳层 e2e):真实 SessionStore + 真实 PiBackend(包裹脚本化 FakeAdapter)+ 真实 GoalDriver,
// 走通「内核事件翻译 → dispatch → 驱动捕获 → store.prompt → backend.sendMessage」全链路,证明 goal 能成功完成。
//
// 不 spawn 真实 pi 二进制、不依赖 LLM/API key——内核进程用脚本化 FakeAdapter 扮演(与 session-store.test.ts
// 同手法)。这里证明的是**壳机制**的正确性:set_goal → 回合收敛 → 注入续跑 → achieve_goal → 停止。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../sessions/session-store";
import type { BackendFactory } from "@my-harness-desktop/shared";
import { PiBackend } from "../../kernel/pi/backend/pi-backend";
import { PiSessionCatalog } from "../../kernel/pi/backend/pi-catalog";
import { cwdToBucketName } from "@my-harness-desktop/shared";
import type { RpcAdapter } from "../../kernel/pi/backend/rpc-adapter";
import type { RpcCommand } from "../../kernel/pi/protocol/rpc-types";
import type { SessionCatalogFactory } from "@my-harness-desktop/shared";
import { ModelCatalog } from "../models/model-catalog";
import { PiModelSource } from "../../kernel/pi/model/pi-model-source";
import { ModelsStore } from "../../kernel/pi/model/models-store";
import { GoalDriver } from "./goal-driver";

const CWD = "/tmp/proj-goal";

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

/** 脚本化假适配器:记录发出的命令 + 可注入内核事件(模拟 pi stdout 事件流)。 */
class ScriptedAdapter {
  alive = false;
  stderr = "";
  sent: RpcCommand[] = [];
  private eventCb: ((event: unknown) => void) | undefined;

  async start(): Promise<void> { this.alive = true; }
  async stop(): Promise<void> { this.alive = false; }
  onEvent(cb: (event: unknown) => void): void { this.eventCb = cb; }
  onBusFrame(): void {}
  onExtensionUI(): void {}

  /** 模拟内核往 stdout 推一条事件。 */
  emit(event: unknown): void { this.eventCb?.(event); }

  async send(command: RpcCommand): Promise<unknown> {
    this.sent.push(command);
    switch (command.type) {
      case "get_state": return { success: true, data: { ...PROC_STATE } };
      case "get_entries": return { success: true, data: { entries: [], leafId: null } };
      case "get_tree": return { success: true, data: { tree: [], leafId: null } };
      case "get_commands": return { success: true, data: { commands: [] } };
      default: return { success: true, data: {} };
    }
  }

  /** 已发出的 prompt 命令(续跑提示断言用)。 */
  promptMessages(): string[] {
    return this.sent
      .filter((c) => c.type === "prompt")
      .map((c) => String((c as { message?: unknown }).message ?? ""));
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

let dir: string;
let sessionPath: string;
let adapter: ScriptedAdapter;
let store: SessionStore;
let driver: GoalDriver;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "goal-driver-e2e-"));
  const bucket = join(dir, "sessions", cwdToBucketName(CWD));
  mkdirSync(bucket, { recursive: true });
  sessionPath = join(bucket, "s1.jsonl");
  writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s1", cwd: CWD, "custom-my-harness-desktop": { kernel: "pi" } }) + "\n");
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "a" }] } } }));

  adapter = new ScriptedAdapter();
  const catalogFactory: SessionCatalogFactory = { create: () => new PiSessionCatalog(dir) };
  const factory: BackendFactory = { create: (opts) => new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir }) };
  store = new SessionStore(factory, catalogFactory, dir, undefined, undefined, new ModelCatalog([new PiModelSource(new ModelsStore({ agentDir: dir }))]));

  store.setContext(CWD, sessionPath);
  await store.start(CWD, sessionPath);
  adapter.sent = [];

  // 与 bootstrap/assemble.ts 同款装配:驱动只依赖 store 的中性面(onEvent/prompt)。
  driver = new GoalDriver({
    onEvent: (cb) => store.onEvent(cb),
    prompt: (text) => store.prompt(text),
  });
  driver.install();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GoalDriver 集成(壳层 e2e:goal 成功完成)", () => {
  it("set_goal → 续跑 → achieve_goal → 停止", async () => {
    // 1. 模型调 set_goal(内核推 tool_execution_start)
    adapter.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "set_goal", args: { objective: "写一个 README" } });
    await flush();
    expect(driver.getState()?.phase).toBe("active");
    expect(driver.getState()?.objective).toBe("写一个 README");

    // 2. 回合收敛 → 驱动经 store.prompt 注入续跑提示(backend.sendMessage → prompt 命令)
    adapter.emit({ type: "agent_settled" });
    await flush();
    const prompts = adapter.promptMessages();
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("写一个 README");
    expect(prompts[0]).toContain("<goal_round>");

    // 3. 模型在续跑轮里调 achieve_goal → 驱动标记达成
    adapter.emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "achieve_goal" });
    await flush();
    expect(driver.getState()?.phase).toBe("achieved");

    // 4. 回合再收敛 → 不再续跑(证明 goal 完成即终止)
    adapter.emit({ type: "agent_settled" });
    await flush();
    expect(adapter.promptMessages().length).toBe(1); // 仍只有第 2 步那一条
  });

  it("未调 achieve_goal 时按 max_rounds 续跑多轮后停止(安全阀)", async () => {
    adapter.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "set_goal", args: { objective: "x", max_rounds: 2 } });
    await flush();

    adapter.emit({ type: "agent_settled" });
    await flush();
    expect(adapter.promptMessages().length).toBe(1);

    adapter.emit({ type: "agent_settled" });
    await flush();
    expect(adapter.promptMessages().length).toBe(2);

    adapter.emit({ type: "agent_settled" });
    await flush();
    expect(adapter.promptMessages().length).toBe(2); // 达上限,停止
  });
});
