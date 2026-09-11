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
  it("★ 模型**卡住不动**（连上就不发数据）→ 按空闲超时失败，且记成 error 而不是 stopped", async () => {
    // 这是"文档说必须有、代码里没有"的那条：客户端只做了中断没做超时，
    // 上游一旦卡住，`reader.read()` 永远挂着 → 回合永不收敛 → 壳侧"运行中"永远转。
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // 故意一个字节都不写，也不 end
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: [{ id: "mock", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "mock-model", name: "Mock" }] }],
      default: { provider: "mock", model: "mock-model" },
    }));

    const prev = process.env.MHD_MINIMAL_MODEL_IDLE_MS;
    process.env.MHD_MINIMAL_MODEL_IDLE_MS = "400"; // 测试接缝：不必真等 120 秒
    try {
      const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-stall" });
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
      t.send({ type: "send", text: "会卡住" });
      // 到点必须收敛：给足余量（400ms 阈值 + 进程启动/清理），但绝不允许"永远不收敛"
      await Promise.race([done, new Promise((_r, rej) => setTimeout(() => rej(new Error("回合没有收敛 —— 空闲超时没生效")), 20000))]);

      const m = (msgEnd as { message?: { error?: boolean; stopped?: boolean } } | null)?.message;
      expect(m?.error, "卡住应按失败记（error），不是用户停止（stopped）").toBe(true);
      expect(m?.stopped).toBeUndefined();
      expect((settled as { reason?: string } | null)?.reason).toBe("error");
      await t.stop();
    } finally {
      if (prev === undefined) delete process.env.MHD_MINIMAL_MODEL_IDLE_MS;
      else process.env.MHD_MINIMAL_MODEL_IDLE_MS = prev;
    }
  });

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
