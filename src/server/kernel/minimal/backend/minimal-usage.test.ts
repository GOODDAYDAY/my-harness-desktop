// minimal 用量与项目统计 —— 文档 §3.3.3 要求 message 里含 **usage / stopReason**，
// 而实现此前**整个丢掉**：流式响应里的 `usage` 帧从没解析过、`finish_reason` 也没留。
//
// 代价不是"少两个字段"，是**连锁的两处功能缺失**（都属"同等功能"）：
//   · 会话的**文件统计基线**（壳侧 `SessionDetail.stats` 明写"message.usage 累加"）在 minimal 上恒空；
//   · `projectStats` 恒返全零 → 壳把各内核数字**相加**，于是 **minimal 的会话在统计面板里
//     等于不存在**（dsh 由内核算、pi 有自己扫描，只有 minimal 是 0）。
//
// 本文件钉两件事：① 真子进程 + 本地 mock SSE 时 usage/stopReason 真的落到盘上、形状与圆心
// `messageUsageOf` 对齐；② `projectStats` 把 minimal 自己的文件**算成真数**（而不是全零）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { messageUsageOf } from "@my-harness-desktop/shared";
import { createMinimalSubprocess } from "./subprocess-lifecycle";
import { MinimalTransport } from "./minimal-transport";
import { MinimalCatalog } from "./minimal-catalog";
import { cwdToBucketName } from "@my-harness-desktop/shared";

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

let agentDir: string;
let cwd: string;
let server: Server;

beforeEach(async () => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-usage-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-usage-proj-"));
  // mock 的最后一帧带 usage（OpenAI 形状）+ finish_reason —— 真网关在
  // `stream_options.include_usage` 下就是这么发的。
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":"用量测试回复"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150,"prompt_tokens_details":{"cached_tokens":20}}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: [{ id: "mock", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "mock-model", name: "Mock" }] }],
    default: { provider: "mock", model: "mock-model" },
  }));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** 真子进程跑一轮，收事件。 */
async function runTurn(sessionId: string, text: string): Promise<Record<string, unknown>[]> {
  const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId });
  const t = new MinimalTransport(handle);
  const events: Record<string, unknown>[] = [];
  const settled = new Promise<void>((resolve) => {
    t.onEvent((e) => {
      events.push(e as unknown as Record<string, unknown>);
      if (e.type === "agentSettled") resolve();
    });
  });
  t.start();
  t.send({ type: "send", text });
  await settled;
  await t.stop();
  return events;
}

const sessionFile = (ns: string): string => join(agentDir, "sessions", cwdToBucketName(cwd), `${ns}.jsonl`);
const entriesOf = (ns: string): Record<string, unknown>[] =>
  readFileSync(sessionFile(ns), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("§3.3.3：message 里真的带 usage / stopReason", () => {
  it("★ 真实一轮后，落盘的 assistant 消息带 usage（形状与圆心 messageUsageOf 对齐）与 stopReason", async () => {
    const events = await runTurn("ns-usage", "跑一轮");
    const end = events.find((e) => e.type === "messageEnd") as { message?: Record<string, unknown> } | undefined;
    expect(end?.message, "messageEnd 没带消息").toBeTruthy();

    const msg = end!.message!;
    expect(msg.usage, "流里的 usage 帧被丢掉了 —— 文档 §3.3.3 要求 message 里含 usage").toBeTruthy();
    expect(msg.stopReason, "finish_reason 没留下 —— 文档要求 message 里含 stopReason").toBe("stop");

    // 落盘与事件**同一份**（写穿先于发事件）
    const lines = entriesOf("ns-usage");
    const assistant = lines.find((l) => (l.message as { role?: string })?.role === "assistant") as { message: Record<string, unknown> };
    expect(assistant, "文件里没有 assistant 条目").toBeTruthy();
    expect(assistant.message.usage).toEqual(msg.usage);
    expect(assistant.message.stopReason).toBe("stop");

    // 形状交给**圆心唯一解析处**验（不是我自己再写一遍期望值）
    const parsed = messageUsageOf(assistant.message);
    expect(parsed).toBeTruthy();
    expect(parsed!.tokens).toEqual({ input: 120, output: 30, cacheRead: 20, cacheWrite: 0, total: 150 });
  });

  it("供应商不给 usage（网关不发那一帧）→ 不写该键，不编造 0", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":"无用量"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: [{ id: "mock", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "mock-model", name: "Mock" }] }],
      default: { provider: "mock", model: "mock-model" },
    }));

    await runTurn("ns-nousage", "跑一轮");
    const assistant = entriesOf("ns-nousage").find((l) => (l.message as { role?: string })?.role === "assistant") as { message: Record<string, unknown> };
    expect("usage" in assistant.message, "拿不到用量就该**不写这个键**——写 0 会被读成「这一轮真没花 token」").toBe(false);
    expect(messageUsageOf(assistant.message)).toBeNull();
  });
});

describe("projectStats：minimal 的会话要算成真数，不是全零", () => {
  it("★ 从自己的会话文件累加 sessionCount / turns / tokens（此前恒返全零）", async () => {
    await runTurn("ns-stats-1", "第一条");
    await runTurn("ns-stats-1", "第二条");
    await runTurn("ns-stats-2", "另一个会话");

    const stats = await new MinimalCatalog(agentDir).projectStats(cwd);
    expect(stats.sessionCount, "两个会话文件就该报 2 —— 全零读起来像「这个项目一条会话都没有」").toBe(2);
    expect(stats.turns, "turns = user 消息条数（共 3 条）").toBe(3);
    // 每次调用一轮 = 150 tokens（input120 + output30）；3 轮
    expect(stats.tokens.total).toBe(450);
    expect(stats.tokens.input).toBe(360);
    expect(stats.tokens.cacheRead).toBe(60);
    expect(stats.cost, "minimal 不做计价：留 0，不编造").toBe(0);
  });

  it("空桶 / 不存在的项目 → 全零（不抛、不编造）", async () => {
    const stats = await new MinimalCatalog(agentDir).projectStats(join(cwd, "never-used"));
    expect(stats).toEqual({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, sessionCount: 0, turns: 0 });
  });

  it("单个文件损坏：跳过它，其余照算（不炸整次统计）", async () => {
    await runTurn("ns-ok", "好文件");
    mkdirSync(join(agentDir, "sessions", cwdToBucketName(cwd)), { recursive: true });
    writeFileSync(join(agentDir, "sessions", cwdToBucketName(cwd), "broken.jsonl"), "{ 这不是 JSON\n", "utf-8");
    const stats = await new MinimalCatalog(agentDir).projectStats(cwd);
    expect(stats.sessionCount, "坏文件也算一条会话（它确实存在）").toBe(2);
    expect(stats.turns, "坏文件里的内容数不出来，但不影响好文件").toBe(1);
    expect(readdirSync(join(agentDir, "sessions", cwdToBucketName(cwd))).length).toBe(2);
  });
});
