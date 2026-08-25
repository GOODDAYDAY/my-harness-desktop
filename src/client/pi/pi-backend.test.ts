// PiBackend 单测:验证 RPC 操作映射到正确的 pi 命令 + 文件级 bookmark/resume(不启动真 pi 进程)。
// 依据 docs/design/base-interface-lineage.md §3.1。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcAdapter } from "./rpc-adapter";
import type { RpcCommand, RpcResponse } from "../../core/protocol/rpc-types";
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

  it("continue 发 follow_up 命令(第八意图适配器翻译)", async () => {
    const { adapter, sent } = fakeAdapter();
    await new PiBackend(adapter, { cwd: "/proj", agentDir: "/tmp/agent" }).continue();
    expect(sent[0]).toMatchObject({ type: "follow_up" });
  });

  it("fork 发 fork 命令(at)并返回 ForkResult(lineageId=新文件路径,sessionReplaced=true)", async () => {
    const { adapter, sent } = fakeAdapter();
    const res = await new PiBackend(adapter, { cwd: "/proj", agentDir: "/tmp/agent" }).fork("ignored", "entry-1");
    expect(sent[0]).toMatchObject({ type: "fork", entryId: "entry-1", position: "at" });
    expect(res.lineageId).toBe("/tmp/s1.jsonl");
    expect(res.sessionReplaced).toBe(true);
  });

  it("fork 缺 boundary 直接报错", async () => {
    const { adapter } = fakeAdapter();
    await expect(new PiBackend(adapter, { cwd: "/proj", agentDir: "/tmp/agent" }).fork("ignored")).rejects.toThrow(/boundary/);
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
