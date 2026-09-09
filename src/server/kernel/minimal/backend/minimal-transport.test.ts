// minimal 子进程 + 传输集成测试 —— spawn minimal-cli.mjs → transport 双向 JSONL → stop。
//
// 依据 docs/design/minimal-kernel.md §4.2。验的是「内核本体是独立子进程」这一层:
// 真实 spawn 进程、真实 stdin/stdout JSONL、真实会话文件落盘,与进程内 echo 版同语义。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMinimalSubprocess } from "./subprocess-lifecycle";
import { MinimalTransport, type MinimalEvent } from "./minimal-transport";

let agentDir: string;
let cwd: string;

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-sub-"));
  // cwd 是 spawn 的 child 工作目录,必须真实存在(否则 spawn ENOENT)。
  cwd = mkdtempSync(join(tmpdir(), "minimal-project-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("MinimalTransport + 子进程", () => {
  it("spawn → ping → send → 事件流 → 会话文件 → stop", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-sub" });
    const t = new MinimalTransport(handle);
    const events: { type: string }[] = [];
    t.onEvent((e) => events.push(e));
    t.start();

    expect(handle.alive).toBe(true);
    const pong = await t.request({ type: "ping" }, "pong");
    expect(pong.type).toBe("pong");

    t.send({ type: "send", text: "子进程你好" });
    // 等 agentSettled(回合收敛)。
    const settled = await new Promise<{ type: string }>((resolve, reject) => {
      const off = t.onEvent((e) => { if (e.type === "agentSettled") { off(); resolve(e); } });
      setTimeout(() => { off(); reject(new Error("send 未收敛(无 agentSettled)")); }, 5000);
    });
    expect(settled.type).toBe("agentSettled");
    const types = events.map((e) => e.type);
    expect(types).toContain("agentStart");
    expect(types).toContain("messageEnd");

    // 会话文件落盘(子进程写)。
    const path = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`, "ns-sub.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("session");
    expect(lines.some((l) => l.type === "message" && l.message.role === "assistant")).toBe(true);

    // getEntries 读回。
    const resp = await t.request<MinimalEvent & { entries: unknown[] }>({ type: "getEntries" }, "entries");
    expect(resp.entries.length).toBeGreaterThan(0);

    await t.stop();
    expect(handle.alive).toBe(false);
  });

  it("崩溃收尾(§4.6.3):onExit 回调在进程退出时触发,graceful stop 带 expected=true", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-exit" });
    const t = new MinimalTransport(handle);
    t.start();
    const exited = new Promise<{ expected: boolean }>((resolve) => {
      t.onExit = (_exit, expected) => resolve({ expected });
    });
    await t.stop(); // graceful stop → stopping=true → expected=true
    const e = await exited;
    expect(e.expected).toBe(true);
    expect(handle.alive).toBe(false);
  });
});
