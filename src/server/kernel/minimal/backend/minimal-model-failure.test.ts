// minimal 模型失败测试 —— mock 服务器返回 5xx,验 §4.6.1:messageEnd 带 error + agentSettled 带 reason。
// 零真实 LLM、零网络。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { createMinimalSubprocess } from "./subprocess-lifecycle";
import { MinimalTransport, type MinimalEvent } from "./minimal-transport";

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

let agentDir: string;
let cwd: string;
let server: Server;
let baseURL: string;

beforeEach(async () => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-fail-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-fail-proj-"));

  // 500 服务器:模型调用失败。
  server = createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end('{"error":"internal error"}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  baseURL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: [{ id: "mock", baseURL, models: [{ id: "mock-model", name: "Mock" }] }],
    default: { provider: "mock", model: "mock-model" },
  }));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("minimal 模型失败", () => {
  it("5xx → messageEnd 带 error:true + agentSettled 带 reason=error(§4.6.1)", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-fail" });
    const t = new MinimalTransport(handle);
    let msgEnd: MinimalEvent | null = null;
    let settled: MinimalEvent | null = null;
    const done = new Promise<void>((resolve) => {
      t.onEvent((e) => {
        if (e.type === "messageEnd") msgEnd = e;
        if (e.type === "agentSettled") { settled = e; resolve(); }
      });
    });
    t.start();
    t.send({ type: "send", text: "会失败" });
    await done;

    const m = (msgEnd as { message?: { error?: boolean; stopped?: boolean } } | null)?.message;
    expect(m?.error).toBe(true); // 模型失败 = error,非 stopped
    expect(m?.stopped).toBeUndefined();
    expect((settled as { reason?: string } | null)?.reason).toBe("error");
    await t.stop();
  });
});
