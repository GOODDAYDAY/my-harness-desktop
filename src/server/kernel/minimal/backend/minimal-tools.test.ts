// minimal 工具系统测试 —— 本地 mock SSE 服务器两轮(第一轮 tool_call、第二轮最终文本),
// 验 CLI 的工具循环(注入 schema → 模型调工具 → 执行回喂 → 最终答案,§4.3.2/§5)。
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
let notePath: string;

beforeEach(async () => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-tool-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-tool-proj-"));
  notePath = join(cwd, "note.txt");
  writeFileSync(notePath, "你好文件", "utf-8");

  // mock 服务器:第一轮(无 tool 消息)返回 read 工具调用;第二轮(有 tool 消息)返回最终文本。
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const hasTool = (parsed.messages ?? []).some((m: { role?: string }) => m.role === "tool");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (!hasTool) {
        const args = JSON.stringify({ path: notePath });
        res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":${JSON.stringify(args)}}}]}}]}\n\n`);
        res.write("data: [DONE]\n\n");
      } else {
        res.write('data: {"choices":[{"delta":{"content":"读取成功"}}]}\n\n');
        res.write("data: [DONE]\n\n");
      }
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

describe("minimal 工具系统(tool loop)", () => {
  it("模型调 read → 执行读文件 → 回喂 → 最终文本", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-tool" });
    const t = new MinimalTransport(handle);
    const events: MinimalEvent[] = [];
    const settled = new Promise<void>((resolve) => {
      t.onEvent((e) => {
        events.push(e);
        if (e.type === "agentSettled") resolve();
      });
    });
    t.start();
    t.send({ type: "send", text: "读一下 note.txt" });
    await settled;

    // 工具事件:toolCallStart(名字 read)→ toolCallEnd(结果含文件内容)。
    const start = events.find((e) => e.type === "toolCallStart");
    const end = events.find((e) => e.type === "toolCallEnd");
    expect(start?.toolName).toBe("read");
    const result = (end as { result?: { text?: string } })?.result;
    expect(result?.text).toBe("你好文件");

    // 最终 messageEnd 含文本(第二轮)。
    const msgEnd = events.find((e) => e.type === "messageEnd") as { message?: { content?: unknown[] } };
    const content = msgEnd.message?.content ?? [];
    expect(content.some((b) => (b as { type: string }).type === "toolCall")).toBe(true); // 工具调用块在内容里
    expect(content.some((b) => (b as { type: string; text?: string }).type === "text" && (b as { text?: string }).text === "读取成功")).toBe(true);

    await t.stop();
  });
});
