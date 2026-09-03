// PiBackend 单测:验证 RPC 操作映射到正确的 pi 命令 + 文件级 bookmark/resume(不启动真 pi 进程)。
// 依据 docs/design/base-interface-lineage.md §3.1。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcAdapter } from "./rpc-adapter";
import type { RpcCommand, RpcResponse } from "../protocol/rpc-types";
import { PiBackend } from "./pi-backend";

/** 记录命令、按类型回 canned 响应的假 RpcAdapter。 */
function fakeAdapter(): { adapter: RpcAdapter; sent: RpcCommand[] } {
  const sent: RpcCommand[] = [];
  const adapter = {
    alive: true,
    start: async () => {},
    stop: async () => {},
    onEvent: () => () => {},
    send: async (cmd: RpcCommand) => {
      sent.push(cmd);
      switch (cmd.type) {
        case "get_state":
          return { type: "response", success: true, data: { sessionFile: "/tmp/s1.jsonl" } } as RpcResponse;
        case "get_entries":
          return { type: "response", success: true, data: { entries: [], leafId: null } } as RpcResponse;
        case "get_tree":
          return { type: "response", success: true, data: { tree: [], leafId: null } } as RpcResponse;
        case "get_commands":
          return { type: "response", success: true, data: { commands: [] } } as RpcResponse;
        default:
          return { type: "response", success: true, data: {} } as RpcResponse;
      }
    },
  } as unknown as RpcAdapter;
  return { adapter, sent };
}

describe("PiBackend", () => {
  it("sendMessage 发 prompt 命令", async () => {
    const { adapter, sent } = fakeAdapter();
    await new PiBackend(adapter, { cwd: "/proj", agentDir: "/tmp/agent" }).sendMessage("hello");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "prompt", message: "hello" });
  });

  it("abort 发 abort 命令", async () => {
    const { adapter, sent } = fakeAdapter();
    await new PiBackend(adapter, { cwd: "/proj", agentDir: "/tmp/agent" }).abort();
    expect(sent[0]).toMatchObject({ type: "abort" });
  });

  it("setModel 发 set_model 命令", async () => {
    const { adapter, sent } = fakeAdapter();
    await new PiBackend(adapter, { cwd: "/proj", agentDir: "/tmp/agent" }).setModel("p", "m");
    expect(sent[0]).toMatchObject({ type: "set_model", provider: "p", modelId: "m" });
  });

  it("sendMessage 撞「already processing」自动降级 followUp 排队(用户消息不再丢)", async () => {
    const { adapter, sent } = fakeAdapter();
    const a = adapter as unknown as { send: (cmd: RpcCommand) => Promise<RpcResponse> };
    const orig = a.send;
    let promptAttempts = 0;
    a.send = async (cmd: RpcCommand) => {
      if (cmd.type === "prompt") {
        promptAttempts++;
        sent.push(cmd);
        if (promptAttempts === 1) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
        return { type: "response", success: true } as RpcResponse;
      }
      return orig(cmd);
    };
    await new PiBackend(adapter, { cwd: "/proj", agentDir: "/tmp/agent" }).sendMessage("ping");
    const prompts = sent.filter((c) => c.type === "prompt");
    expect(prompts).toHaveLength(2);
    expect((prompts[1] as { streamingBehavior?: string }).streamingBehavior).toBe("followUp");
  });

  // 守卫(回归):pi 内核 extension_ui_request 帧把 title/options 放顶层(0.84.x rpc-types 权威),
  // 此前误读 req.payload.* 导致提问内容恒空、卡片防御丢弃、60s 超时兜底取消——ask 全链路断。
  it("onQuestion 翻译真实帧形状(顶层 title/options),内容不丢", () => {
    const { adapter } = fakeAdapter();
    let listener: ((req: unknown) => void) | null = null;
    (adapter as { onExtensionUI?: unknown }).onExtensionUI = (cb: (req: unknown) => void) => {
      listener = cb;
      return () => {};
    };
    const backend = new PiBackend(adapter, { cwd: "/proj", agentDir: "/tmp/agent" });
    const got: { requestId: string; questions: { question: string; options: { label: string }[] }[] }[] = [];
    backend.onQuestion!((req) => got.push(req as (typeof got)[number]));
    expect(listener).not.toBeNull();
    // 真实线格式(pi 0.84.3 rpc-types.d.ts):title/options 顶层
    listener!({ type: "extension_ui_request", id: "r1", method: "select", title: "选哪个?", options: ["A", "B"] });
    expect(got[0].questions[0].question).toBe("选哪个?");
    expect(got[0].questions[0].options.map((o) => o.label)).toEqual(["A", "B"]);
    // 旧 payload 包装形态兜底兼容
    listener!({ type: "extension_ui_request", id: "r2", method: "input", payload: { title: "输入点啥" } });
    expect(got[1].questions[0].question).toBe("输入点啥");
    // 非 select/input 显式降级不投
    listener!({ type: "extension_ui_request", id: "r3", method: "notify", message: "hi" });
    expect(got).toHaveLength(2);
  });


  it("getTree/getEntries 走 resync,空树投出空 lineage 树", async () => {
    const { adapter } = fakeAdapter();
    const backend = new PiBackend(adapter, { cwd: "/proj", agentDir: "/tmp/agent" });
    await expect(backend.getTree("s")).resolves.toEqual({ rootId: "", lineages: [] });
    await expect(backend.getEntries("l")).resolves.toEqual([]);
  });
});

describe("PiBackend bookmark/resume(文件级)", () => {
  let agentDir: string;
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-backend-"));
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    mkdirSync(join(agentDir, "bookmarks"), { recursive: true });
  });
  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("bookmark 只存中立坐标(去副本),resume 抛「走 session-store 编排」", async () => {
    const { adapter } = fakeAdapter();
    const backend = new PiBackend(adapter, { cwd: agentDir, agentDir });
    const src = join(agentDir, "sessions", "src.jsonl");
    writeFileSync(src, '{"type":"session"}\n', "utf8");

    const anchor = await backend.bookmark(src, "entry-1");
    expect(anchor.lineageId).toBe(src);
    expect(anchor.entryId).toBe("entry-1");
    // 去副本:bookmark 不拷贝文件(bookmarks 目录空)
    expect(readdirSync(join(agentDir, "bookmarks"))).toHaveLength(0);
  });

  it("seed 把中立会话树重建为 JSONL(头行 + 线性 message 条目 + parentId 链)", async () => {
    const { adapter } = fakeAdapter();
    const backend = new PiBackend(adapter, { cwd: "/proj", agentDir });
    const path = await backend.seed([
      { neutralEntryId: "root:0", kernelEntryId: "m1", message: { role: "user", content: "你好", id: "m1" } },
      { neutralEntryId: "root:1", kernelEntryId: "m2", message: { role: "assistant", content: [{ type: "text", text: "你好!" }], id: "m2" } },
    ], { neutralSessionId: "ns-1", lineageId: "root", header: { kernel: "pi", cwd: "/proj", createdAt: new Date().toISOString() } });
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(join(agentDir, "sessions"))).toBe(true);

    const lines = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("session");
    expect(lines[0].cwd).toBe("/proj");
    // 会话头重绑(§5.4 第 3 项):内核归属记进 custom-my-harness-desktop.kernel
    expect(lines[0]["custom-my-harness-desktop"].kernel).toBe("pi");
    expect(lines).toHaveLength(3); // 头行 + 2 条 message
    expect(lines[1].type).toBe("message");
    expect(lines[1].message.role).toBe("user");
    expect(lines[2].message.role).toBe("assistant");
    // 线性 parentId 链:m2 挂 m1 之后(kernelEntryId 复用)
    expect(lines[2].parentId).toBe("m1");
  });
});
