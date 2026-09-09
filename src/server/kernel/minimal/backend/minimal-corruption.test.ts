// minimal 会话文件损坏韧性测试 —— §9.7.2:损坏行跳过、健康条目健在(读口不炸)。
// 零真实 LLM、零网络。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMinimalSubprocess } from "./subprocess-lifecycle";
import { MinimalTransport, type MinimalEvent } from "./minimal-transport";
import { minimalSeedSession } from "./minimal-catalog";

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

let agentDir: string;
let cwd: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-corr-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-corr-proj-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("minimal 会话文件损坏韧性", () => {
  it("损坏行跳过,健康条目健在(§9.7.2)", async () => {
    // 种一个会话文件,再追加一条损坏行(非 JSON)。
    const path = minimalSeedSession(agentDir, cwd, [
      { neutralEntryId: "ns-corr:0", message: { role: "user", content: "健康条目" } },
    ], { lineageId: "ns-corr", header: { kernel: "minimal", cwd, createdAt: new Date().toISOString() } });
    appendFileSync(path, "这不是 JSON\n", "utf-8");

    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-corr" });
    const t = new MinimalTransport(handle);
    t.start();
    const resp = await t.request<MinimalEvent & { entries: unknown[] }>({ type: "getEntries" }, "entries");
    // 损坏行被跳过,健康条目仍在。
    expect(resp.entries.length).toBe(2); // 头行 + 健康 message(损坏行已剔除)
    const msgs = resp.entries.filter((e) => (e as { type?: string }).type === "message");
    expect(msgs.length).toBe(1);
    await t.stop();
  });
});
