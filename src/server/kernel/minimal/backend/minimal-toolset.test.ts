// minimal 工具集读回测试 —— 头行 tools 快照 → CLI 启动读回 → 注入模型请求(§5.6.1 闭环)。
// 零真实 LLM、零网络。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { createMinimalSubprocess } from "./subprocess-lifecycle";
import { MinimalTransport, type MinimalEvent } from "./minimal-transport";
import { minimalSeedSession } from "./minimal-catalog";

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

let agentDir: string;
let cwd: string;
let server: Server;
let baseURL: string;
let lastToolCount = -1;

beforeEach(async () => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-toolset-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-toolset-proj-"));
  lastToolCount = -1;

  // mock 服务器:记录请求里的 tools 数量,返回最终文本(不触发工具回环)。
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      lastToolCount = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
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

describe("minimal 工具集读回", () => {
  it("头行 tools=full → CLI 启动读回 → 模型请求注入 4 个工具 schema(§5.6.1)", async () => {
    // 种一个头行 tools=full 的会话文件(模拟 updateHeader 翻译后的快照)。
    const path = minimalSeedSession(agentDir, cwd, [
      { neutralEntryId: "ns-toolset:0", message: { role: "user", content: "x" } },
    ], { lineageId: "ns-toolset", header: { kernel: "minimal", cwd, createdAt: new Date().toISOString() } });
    const lines = path ? require("node:fs").readFileSync(path, "utf-8").split("\n") : [];
    const header = JSON.parse(lines[0]);
    header.tools = "full";
    lines[0] = JSON.stringify(header);
    require("node:fs").writeFileSync(path, lines.join("\n"), "utf-8");

    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-toolset" });
    const t = new MinimalTransport(handle);
    const settled = new Promise<void>((resolve) => {
      t.onEvent((e) => { if (e.type === "agentSettled") resolve(); });
    });
    t.start();
    t.send({ type: "send", text: "hi" });
    await settled;
    // full = read + list + write + bash = 4 个工具 schema。
    expect(lastToolCount).toBe(4);
    await t.stop();
  });

  it("setTools 热切换工具集(§5.6.1 补面):read-only(默认)→ full,注入 schema 从 2 → 4", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-toolset-hot" });
    const t = new MinimalTransport(handle);
    t.start();
    // 默认 read-only:第一次发送注入 2 个工具。
    let settled = new Promise<void>((resolve) => { t.onEvent((e) => { if (e.type === "agentSettled") resolve(); }); });
    t.send({ type: "send", text: "a" });
    await settled;
    expect(lastToolCount).toBe(2);
    // 热切 full:第二次发送注入 4 个工具(不重开进程)。
    settled = new Promise<void>((resolve) => { t.onEvent((e) => { if (e.type === "agentSettled") resolve(); }); });
    t.send({ type: "setTools", tools: "full" });
    t.send({ type: "send", text: "b" });
    await settled;
    expect(lastToolCount).toBe(4);
    await t.stop();
  });
});
