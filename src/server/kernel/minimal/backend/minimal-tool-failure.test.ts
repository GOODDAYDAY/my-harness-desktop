// minimal 工具边界测试 —— 工具失败 isError 回喂 + 多轮工具回环,验 §5.3.2/§5.10。
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
let requests: { toolCount: number; hasErrorTool: boolean }[];

beforeEach(async () => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-tooledge-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-tooledge-proj-"));
  requests = [];

  // 有状态 mock 服务器:按 tool 消息数分流。
  // 轮 0(无 tool)→ unknown-tool 调用;轮 1(有 tool,含 isError)→ 最终文本「恢复成功」。
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const toolMsgs = (parsed.messages ?? []).filter((m: { role?: string }) => m.role === "tool");
      const toolCount = toolMsgs.length;
      const hasErrorTool = toolMsgs.some((m: { content?: string }) => String(m.content).includes("unknown tool"));
      requests.push({ toolCount, hasErrorTool });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (toolCount === 0) {
        // 第一轮:调一个不存在的工具(§5.3.2 失败路径)。
        const args = JSON.stringify({});
        res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"no-such-tool","arguments":${JSON.stringify(args)}}}]}}]}\n\n`);
        res.write("data: [DONE]\n\n");
      } else {
        // 第二轮:模型看到 isError 后恢复,给最终文本。
        res.write('data: {"choices":[{"delta":{"content":"恢复成功"}}]}\n\n');
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

describe("minimal 工具边界", () => {
  it("未知工具 → isError 回喂 → 模型第二轮恢复(§5.3.2)", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-tooledge" });
    const t = new MinimalTransport(handle);
    const events: MinimalEvent[] = [];
    const settled = new Promise<void>((resolve) => {
      t.onEvent((e) => {
        events.push(e);
        if (e.type === "agentSettled") resolve();
      });
    });
    t.start();
    t.send({ type: "send", text: "调个不存在的工具" });
    await settled;

    // 工具失败事件:toolCallEnd 带 isError=true。
    const end = events.find((e) => e.type === "toolCallEnd");
    expect(end?.isError).toBe(true);

    // 两轮:第一轮调工具、第二轮(含 isError 回喂)出最终文本。
    expect(requests.length).toBe(2);
    expect(requests[0].toolCount).toBe(0);
    expect(requests[1].toolCount).toBe(1);
    expect(requests[1].hasErrorTool).toBe(true);

    // 最终 messageEnd 含「恢复成功」。
    const msgEnd = events.find((e) => e.type === "messageEnd") as { message?: { content?: { type: string; text?: string }[] } };
    const text = (msgEnd.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    expect(text).toBe("恢复成功");
    await t.stop();
  });
});
