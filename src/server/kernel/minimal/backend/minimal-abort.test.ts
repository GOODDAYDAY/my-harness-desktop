// minimal 中断语义测试 —— 慢流 SSE + abort 掐断,验 §4.6.2:stopped 而非 error + 保留部分内容。
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
  agentDir = mkdtempSync(join(tmpdir(), "minimal-abort-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-abort-proj-"));

  // 慢流服务器:两段 delta 各隔 300ms,给 abort 留窗口。
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n');
      setTimeout(() => {
        res.write("data: [DONE]\n\n");
        res.end();
      }, 300);
    }, 300);
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

describe("minimal 中断(abort)", () => {
  it("abort 掐断流 → messageEnd 带 stopped(非 error)+ 保留第一段", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-abort" });
    const t = new MinimalTransport(handle);
    let firstDeltaSeen: (() => void) | null = null;
    const firstDelta = new Promise<void>((r) => (firstDeltaSeen = r));
    let msgEnd: MinimalEvent | null = null;
    /** 全部事件（含 error）——**必须一起收**：只看 messageEnd 的话，
     *  "abort 命令自身抛错、被转成一个多余 error 事件"这种缺陷会从守卫旁边溜过去。
     *  实测就这么漏过一次：`aborted = true` 指向一个已被删除的变量（ESM 严格模式 → ReferenceError），
     *  每次 abort 都多发一个 error 事件，而原守卫只断言"消息带 stopped"，一路绿。 */
    const allEvents: MinimalEvent[] = [];
    const settled = new Promise<void>((resolve) => {
      t.onEvent((e) => {
        allEvents.push(e);
        if (e.type === "messageUpdate") firstDeltaSeen?.();
        if (e.type === "messageEnd") msgEnd = e;
        if (e.type === "agentSettled") resolve();
      });
    });
    t.start();
    t.send({ type: "send", text: "长回复" });
    await firstDelta; // 等到第一段流式到达
    t.send({ type: "abort" }); // 中断
    await settled;

    const m = (msgEnd as { message?: { stopped?: boolean; error?: boolean; content?: { type: string; text: string }[] } } | null)?.message;
    expect(m?.stopped).toBe(true); // 中断 = stopped,非 error
    expect(m?.error).toBeUndefined();
    const text = (m?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    expect(text).toContain("第一段"); // 已收部分内容保留
    expect(text).not.toContain("第二段"); // 中断后未收
    // 中断**不是错误**:整个 abort 链路（含 abort 命令本身）不许产出任何 error 事件。
    expect(
      allEvents.filter((e) => e.type === "error"),
      "abort 链路产出了 error 事件——中断语义被当成错误，且多半意味着命令处理里抛了异常",
    ).toEqual([]);
    await t.stop();
  });
});
