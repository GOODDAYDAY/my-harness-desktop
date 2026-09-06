// sub-agent 编排核心纯逻辑单测(三级测试第一级,补零测试缺口):
//   orchestrator 的可纯测面——handleFrame 路由/settle 终态闭环/isActive 判定/
//   spawn 七步中可离线验的闸(max_concurrent/递归权威闸/tasks_empty)。
//   端口全 mock(ports 是注入接口,天然可测——§4.5 判据:接口在圆心/插件内,实现可 mock)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionBusMessage } from "@my-harness-desktop/shared";
import { SubagentOrchestrator, isActive, type SubRecord, type OrchestratorPorts } from "./orchestrator";

function makePorts(over: Partial<OrchestratorPorts> = {}): OrchestratorPorts {
  return {
    bus: {
      send: vi.fn().mockResolvedValue({ delivered: [] }),
      status: vi.fn().mockResolvedValue({
        sessions: [{ address: "session:parent", key: "k1", cwd: "/proj", sessionPath: "/proj/s.jsonl" }],
      }),
      tapStart: vi.fn().mockResolvedValue({ tapId: "t1" }),
      tapStop: vi.fn(),
      sessionCreate: vi.fn().mockResolvedValue({ session: "session:child-1", sessionPath: "/proj/c1.jsonl" }),
      sessionAbort: vi.fn(),
      channelMember: vi.fn(),
    },
    sessions: {
      list: vi.fn().mockResolvedValue([{ path: "/proj/s.jsonl", custom: {} }]),
      updateHeader: vi.fn().mockResolvedValue(undefined),
      annotate: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue([]),
    },
    configFile: {
      get: vi.fn().mockResolvedValue({}),
      append: vi.fn().mockResolvedValue(undefined),
    },
    now: () => Date.now(),
    uuid: () => "uuid-" + Math.random().toString(36).slice(2),
    ...over,
  } as OrchestratorPorts;
}

function frame(over: Record<string, unknown> = {}) {
  return { $bus: true, id: "req-1", from: "session:parent", to: "orch", kind: "subagent_ping", payload: {}, timestamp: 0, ...over } as SessionBusMessage;
}

describe("isActive(运行中判定)", () => {
  it("running 为 true,其余全 false", () => {
    expect(isActive({ status: "running" } as SubRecord)).toBe(true);
    for (const s of ["done", "error", "aborted", "timeout", "spawn_failed", "interrupted"] as const) {
      expect(isActive({ status: s } as SubRecord)).toBe(false);
    }
  });
});

describe("Orchestrator.handleFrame 路由", () => {
  let orch: SubagentOrchestrator;
  beforeEach(() => {
    orch = new SubagentOrchestrator(makePorts(), "orch", "/config/sub-agent.json");
  });

  it("非本址帧:不处理(to 不符直接丢)", async () => {
    const reply = vi.spyOn(orch, "reply");
    await orch.handleFrame(frame({ to: "someone-else" }));
    expect(reply).not.toHaveBeenCalled();
  });

  it("subagent_ping → 回 pong(自活探测)", async () => {
    const reply = vi.spyOn(orch, "reply");
    await orch.handleFrame(frame({ kind: "subagent_ping" }));
    expect(reply).toHaveBeenCalledWith(expect.anything(), { pong: true });
  });

  it("未知 kind:静默丢弃(不炸)", async () => {
    await orch.handleFrame(frame({ kind: "no_such_kind" }));
    // 不抛错即通过
  });
});

describe("spawn 闸(七步的前置,可离线验)", () => {
  it("tasks 空:回 tasks_empty(不派)", async () => {
    const ports = makePorts();
    const orch = new SubagentOrchestrator(ports, "orch", "/c.json");
    const send = ports.bus.send as ReturnType<typeof vi.fn>;
    await orch.handleFrame(frame({ kind: "spawn_subagent", payload: { tasks: [] } }));
    expect(send).toHaveBeenCalledWith("session:parent", "bus_response", { error: "tasks_empty" }, "req-1");
  });

  it("递归权威闸:活跃子未声明 allowSpawn 再派生 → 整批拒绝", async () => {
    const ports = makePorts();
    const orch = new SubagentOrchestrator(ports, "orch", "/c.json");
    orch.subs.set("session:parent", { addr: "session:parent", parentAddr: "orch", status: "running", allowSpawn: false, name: "子", task: "t", cwd: "/proj", sessionPath: "/p/c.jsonl", parentSessionPath: "/p/s.jsonl", spawnedAt: 1, batchId: undefined, waiterFor: undefined, timeoutAt: 1, abortReason: undefined } as unknown as SubRecord);
    await orch.handleFrame(frame({ kind: "spawn_subagent", payload: { tasks: ["新活"] } }));
    expect(ports.bus.send).toHaveBeenCalledWith("session:parent", "bus_response", expect.objectContaining({ error: "spawn_not_allowed" }), "req-1");
  });

  it("max_concurrent:活跃+请求超限 → 拒绝(带 active/requested/limit)", async () => {
    const ports = makePorts();
    ports.configFile.get = vi.fn().mockResolvedValue({ maxConcurrent: 1 });
    const orch = new SubagentOrchestrator(ports, "orch", "/c.json");
    orch.subs.set("session:child-0", { addr: "session:child-0", parentAddr: "session:parent", status: "running", allowSpawn: true, name: "已有子", task: "t", cwd: "/proj", sessionPath: "/p/c0.jsonl", spawnedAt: 1, batchId: undefined, waiterFor: undefined, timeoutAt: 1, abortReason: undefined } as unknown as SubRecord);
    await orch.handleFrame(frame({ kind: "spawn_subagent", payload: { tasks: ["又派一个"] } }));
    expect(ports.bus.send).toHaveBeenCalledWith("session:parent", "bus_response", expect.objectContaining({ error: "max_concurrent", active: 1, requested: 1, limit: 1 }), "req-1");
  });

  it("父不运行:parent_not_running(派活必须父活着)", async () => {
    const ports = makePorts();
    ports.bus.status = vi.fn().mockResolvedValue({ sessions: [] });
    const orch = new SubagentOrchestrator(ports, "orch", "/c.json");
    await orch.handleFrame(frame({ kind: "spawn_subagent", payload: { tasks: ["任务"] } }));
    expect(ports.bus.send).toHaveBeenCalledWith("session:parent", "bus_response", expect.objectContaining({ error: "parent_not_running" }), "req-1");
  });
});

describe("session_done 终态闭环(settle)", () => {
  it("done 帧更新账目状态 + 通知监听者", async () => {
    const ports = makePorts();
    const orch = new SubagentOrchestrator(ports, "orch", "/c.json");
    orch.subs.set("session:child-1", { addr: "session:child-1", parentAddr: "session:parent", status: "running", allowSpawn: false, name: "子", task: "t", cwd: "/proj", sessionPath: "/p/c.jsonl", spawnedAt: 1, batchId: undefined, waiterFor: undefined, timeoutAt: 1, abortReason: undefined } as unknown as SubRecord);
    let notified = 0;
    orch.onChange(() => notified++);
    await orch.handleFrame(frame({ kind: "session_done", from: "session:child-1", to: "orch", payload: { session: "session:child-1", status: "done", output: "干完了" } }));
    // onSessionDone 里 settle 是 void(异步 fire-and-forget)——排干微任务再断言
    await new Promise((r) => setTimeout(r, 10));
    expect(orch.getSub("session:child-1")?.status).toBe("done");
    expect(notified).toBeGreaterThan(0);
  });
});
