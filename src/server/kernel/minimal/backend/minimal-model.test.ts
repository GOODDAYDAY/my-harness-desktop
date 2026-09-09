// minimal 模型客户端 e2e 测试 —— 本地 mock SSE 服务器 → CLI 流式收 delta。
//
// 依据 docs/design/minimal-kernel.md §4.7/§4.8。用本地 HTTP 服务器模拟 OpenAI 兼容
// /chat/completions 的 SSE 流(零真实 LLM、零网络),验 CLI 的 streamModel 逐 delta 翻译成
// messageUpdate。echo 兜底已在 minimal-backend.test 覆盖,这里专测「真模型」路径。

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
  agentDir = mkdtempSync(join(tmpdir(), "minimal-mdl-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-mdl-proj-"));

  // mock SSE 服务器:POST /v1/chat/completions → 两段 delta + [DONE]。
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 40);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  baseURL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;

  // minimal 模型配置(§4.9):providers + default,apiKey 落凭证文件。
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: [{ id: "mock", baseURL, models: [{ id: "mock-model", name: "Mock" }] }],
    default: { provider: "mock", model: "mock-model" },
  }));
  writeFileSync(join(agentDir, ".credentials.json"), JSON.stringify({ mock: "sk-test" }));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("minimal 模型客户端(SSE)", () => {
  it("send → 流式 messageUpdate 来自模型(非 echo)", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-mdl" });
    const t = new MinimalTransport(handle);
    const deltas: string[] = [];
    const settled = new Promise<void>((resolve) => {
      t.onEvent((e) => {
        if (e.type === "messageUpdate") {
          const blocks = (e as MinimalEvent & { message: { content?: { type: string; text: string }[] } }).message.content ?? [];
          for (const b of blocks) if (b.type === "text") deltas.push(b.text);
        }
        if (e.type === "agentSettled") resolve();
      });
    });
    t.start();
    t.send({ type: "send", text: "提问" });
    await settled;
    expect(deltas.join("")).toBe("你好，世界");
    expect(deltas.join("")).not.toContain("[minimal echo]");
    await t.stop();
  });
});
