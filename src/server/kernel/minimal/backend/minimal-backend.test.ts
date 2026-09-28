// minimal 后端契约单测 —— BaseBackend 14 条意图 + 事件流,经真实 CLI 子进程兑现。
//
// 依据 docs/design/minimal-kernel.md §7.1 + §4。测的是「minimal 是第三个可托管内核」的
// 契约面:spawn 后 alive、发消息事件流、切模型/命名、树与条目、书签坐标、seed 落盘。
// CLI 是独立 .mjs(echo 占位),真模型 SSE 是后续里程碑。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMinimalBackend } from "./minimal-backend-factory";
import { minimalDerivedSessionPath } from "./minimal-catalog";
import type { SessionEvent } from "@my-harness-desktop/shared";

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

let agentDir: string;
let cwd: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-agent-"));
  // cwd 是 spawn 的 child 工作目录,必须真实存在(否则 spawn ENOENT)。
  cwd = mkdtempSync(join(tmpdir(), "minimal-project-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function makeBackend(ns = "ns-1") {
  return createMinimalBackend({ cwd, agentDir, kernel: "minimal", neutralSessionId: ns, cliPath: CLI_PATH });
}

describe("MinimalBackend 契约", () => {
  it("内核身份是 minimal", () => {
    expect(makeBackend().kernel).toBe("minimal");
  });

  it("工厂即 spawn(alive=true),stop 后 alive=false", async () => {
    const b = makeBackend();
    expect(b.alive).toBe(true); // 工厂 spawn CLI,进程即存活
    await b.start(); // 挂行读 + ping 就绪探测
    expect(b.alive).toBe(true);
    await b.stop();
    expect(b.alive).toBe(false);
  });

  it("sendMessage 产出完整事件流 + echo 内容", async () => {
    const b = makeBackend();
    const events: SessionEvent[] = [];
    const settled = new Promise<void>((resolve) => {
      b.onEvent((e) => { events.push(e); if (e.type === "agentSettled") resolve(); });
    });
    await b.start();
    await b.sendMessage("你好");
    await settled; // 事件驱动等 agentSettled(不 sleep,§3.6)
    const types = events.map((e) => e.type);
    expect(types).toContain("agentStart");
    expect(types).toContain("messageStart");
    expect(types).toContain("messageUpdate");
    expect(types).toContain("messageEnd");
    expect(types).toContain("agentSettled");
    // 顺序:agentStart 先于 messageStart,agentSettled 收尾。
    expect(types.indexOf("agentStart")).toBeLessThan(types.indexOf("messageStart"));
    expect(types.indexOf("messageEnd")).toBeLessThan(types.indexOf("agentSettled"));
    // messageEnd 的 assistant 内容含 echo。
    const end = events.find((e) => e.type === "messageEnd") as { message?: { content?: unknown } };
    const text = (end.message?.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("[minimal echo] 你好");
  });

  it("setModel 落 model_change 条目", async () => {
    const b = makeBackend();
    await b.start();
    await b.setModel("provider-a", "model-b");
    const entries = await b.getEntries("ns-1");
    const modelChange = entries.find((m) => m.role === "divider" && m.kind === "model");
    expect(modelChange).toBeTruthy();
  });

  it("setSessionName 落 session_info 条目", async () => {
    const b = makeBackend();
    await b.start();
    await b.setSessionName("我的会话");
    const entries = await b.getEntries("ns-1");
    const renamed = entries.find((m) => m.role === "divider" && m.kind === "info");
    expect(renamed).toBeTruthy();
  });

  it("bookmark 只存中立坐标", async () => {
    const b = makeBackend();
    const anchor = await b.bookmark("lineage-1", "entry-3");
    expect(anchor).toEqual({ lineageId: "lineage-1", entryId: "entry-3" });
  });

  it("seed 写会话文件并返回派生路径", async () => {
    const b = makeBackend("ns-seed");
    const path = await b.seed(
      [{ neutralEntryId: "ns-seed:0", message: { role: "user", content: "历史消息" } }],
      { neutralSessionId: "ns-seed", lineageId: "ns-seed", header: { kernel: "minimal", cwd, createdAt: new Date().toISOString() } },
    );
    expect(path).toContain("ns-seed.jsonl");
    await b.start();
    const entries = await b.getEntries("ns-seed");
    expect(entries.some((m) => m.role === "user" && JSON.stringify(m.content).includes("历史消息"))).toBe(true);
  });

  it("getTree 返回单 lineage 树", async () => {
    const b = makeBackend("ns-tree");
    await b.seed(
      [{ neutralEntryId: "ns-tree:0", message: { role: "user", content: "x" } }],
      { neutralSessionId: "ns-tree", lineageId: "ns-tree", header: { kernel: "minimal", cwd, createdAt: new Date().toISOString() } },
    );
    await b.start();
    const tree = await b.getTree("ns-tree");
    expect(tree.rootId).toBe("ns-tree");
    expect(tree.lineages).toHaveLength(1);
    expect(tree.lineages[0]?.fork).toBeNull();
  });

  it("sendMessage 后 getEntries 能读回 user/assistant(格式对应)", async () => {
    const b = makeBackend("ns-fmt");
    const settled = new Promise<void>((resolve) => {
      b.onEvent((e) => { if (e.type === "agentSettled") resolve(); });
    });
    await b.start();
    await b.sendMessage("格式");
    await settled;
    const entries = await b.getEntries("ns-fmt");
    const roles = entries.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const assistant = entries.find((m) => m.role === "assistant");
    const blocks = assistant?.content as { type: string; text: string }[];
    expect(blocks[0].text).toContain("[minimal echo] 格式");
  });

  it("listTools 经协议返回内置工具清单", async () => {
    const b = makeBackend();
    await b.start();
    const tools = await (b.listTools?.() ?? null);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools?.some((t) => t.name === "read")).toBe(true);
  });

  it("写穿先于发事件(§4.3.3):messageEnd 到达时 assistant 条目已在文件里", async () => {
    const ns = "ns-write";
    const b = makeBackend(ns);
    const path = minimalDerivedSessionPath(agentDir, cwd, ns);
    await b.start();
    let sawAssistantAtMessageEnd = false;
    b.onEvent((e) => {
      if (e.type === "messageEnd") {
        const content = readFileSync(path, "utf-8");
        sawAssistantAtMessageEnd = content.includes('"role":"assistant"') || content.includes("assistant");
      }
    });
    const settled = new Promise<void>((resolve) => {
      b.onEvent((e) => { if (e.type === "agentSettled") resolve(); });
    });
    await b.sendMessage("写穿");
    await settled;
    expect(sawAssistantAtMessageEnd).toBe(true); // messageEnd 事件发出时条目已写穿(非先发后写)
  });
});
