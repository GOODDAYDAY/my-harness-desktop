// PiBackend 单测:验证 RPC 操作映射到正确的 pi 命令(不启动真 pi 进程)。
// 依据 docs/design/base-interface-lineage.md §3.1。
import { describe, it, expect } from "vitest";
import type { RpcAdapter } from "../../../client/pi/rpc-adapter";
import type { RpcCommand, RpcResponse } from "../../protocol/rpc-types";
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
    await new PiBackend(adapter).sendMessage("hello");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "prompt", message: "hello" });
  });

  it("abort 发 abort 命令", async () => {
    const { adapter, sent } = fakeAdapter();
    await new PiBackend(adapter).abort();
    expect(sent[0]).toMatchObject({ type: "abort" });
  });

  it("setModel 发 set_model 命令", async () => {
    const { adapter, sent } = fakeAdapter();
    await new PiBackend(adapter).setModel("p", "m");
    expect(sent[0]).toMatchObject({ type: "set_model", provider: "p", modelId: "m" });
  });

  it("fork 发 fork 命令(at)并返回新会话文件路径", async () => {
    const { adapter, sent } = fakeAdapter();
    const lineageId = await new PiBackend(adapter).fork("ignored", "entry-1");
    expect(sent[0]).toMatchObject({ type: "fork", entryId: "entry-1", position: "at" });
    expect(lineageId).toBe("/tmp/s1.jsonl");
  });

  it("fork 缺 boundary 直接报错", async () => {
    const { adapter } = fakeAdapter();
    await expect(new PiBackend(adapter).fork("ignored")).rejects.toThrow(/boundary/);
  });

  it("getTree/getEntries 走 resync,空树投出空 lineage 树", async () => {
    const { adapter } = fakeAdapter();
    const backend = new PiBackend(adapter);
    await expect(backend.getTree("s")).resolves.toEqual({ rootId: "", lineages: [] });
    await expect(backend.getEntries("l")).resolves.toEqual([]);
  });

  it("bookmark/resume 未接线时报错", async () => {
    const { adapter } = fakeAdapter();
    const backend = new PiBackend(adapter);
    await expect(backend.bookmark("l", "b")).rejects.toThrow(/未接线/);
    await expect(backend.resume({ lineageId: "l", boundary: "b", opaque: "x" })).rejects.toThrow(/未接线/);
  });
});
