// 工具**运行时**的两条纪律（§5.3.2 强制超时 / §5.7.1 受控写）+ 一条它们共同支撑的语义（§4.6.2）。
//
// 为什么这几条要单独成文件：它们不是"工具功能对不对"，而是**工具执行期间内核还活着吗**。
// 此前 `bash` 用 `execFileSync` —— 同步阻塞。后果不是"少了个超时参数"，而是：
//   · 一个 `while true` 的子进程能把整个 minimal 进程永久卡死，超时机制无从触发（§5.3.2 原话）；
//   · 工具跑的时候 CLI **读不到 stdin**，于是 §4.6.2 写明的「用户点 abort 时，一个正在跑的 bash
//     会自己跑完或到超时被 kill」根本不成立 —— abort 命令压根进不来，CLI 是聋的。
// 这两条是同一根因（同步执行）的两个面，所以守卫也成对。
//
// 零真实 LLM、零网络：模型侧用本地 mock SSE。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
// @ts-expect-error 内核侧 .mjs 无类型声明（纯 JS 进内核进程，不经 TS 构建）
import { executeTool, setProjectRoot } from "../kernel/minimal-tools.mjs";
import { createMinimalSubprocess } from "./subprocess-lifecycle";
import { MinimalTransport, type MinimalEvent } from "./minimal-transport";

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

describe("§5.3.2 强制超时 / §5.7.1 受控写（工具运行时）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minimal-toolrt-"));
    setProjectRoot(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("§5.3.2：工具超时被**强制执行**（不等它自己返回），并标 timeout", async () => {
    const t0 = Date.now();
    const r = await executeTool("bash", { command: "sleep 30" }, { timeoutMs: 200 });
    const elapsed = Date.now() - t0;
    expect(r.isError, "超时必须落成 isError 结果（回喂给模型），不是抛出去").toBe(true);
    expect(r.timeout, "结果里要能看出这是超时（模型据此换策略）").toBe(true);
    expect(elapsed, `超时没被强制：等了 ${elapsed}ms（应 ~200ms）——同步执行会让这个包装形同虚设`).toBeLessThan(3000);
  });

  it("§5.3.2：超时会 kill 掉工具起的子进程（不留孤儿）", async () => {
    const marker = join(dir, "marker.txt");
    // 命令：先睡 3 秒再写文件。若子进程被 kill，文件永远不出现。
    const r = await executeTool("bash", { command: `sleep 1; echo done > ${marker}` }, { timeoutMs: 200 });
    expect(r.isError).toBe(true);
    await new Promise((res) => setTimeout(res, 1500)); // 等过原命令的完成时刻
    expect(existsSync(marker), "子进程没被 kill：超时之后它还在跑并写出了文件").toBe(false);
  });

  it("§5.7.1：write 只能写项目目录内（绝对路径越界被拒）", async () => {
    const outside = join(tmpdir(), `minimal-outside-${Date.now()}.txt`);
    const r = await executeTool("write", { path: outside, content: "x" });
    expect(r.isError, "write 竟然写出了项目目录（它是受控写，不是危险工具）").toBe(true);
    expect(String(r.error)).toContain("越界");
    expect(existsSync(outside)).toBe(false);
  });

  it("§5.7.1：`..` 也不行（只在字面上判前缀会被它绕过）", async () => {
    const r = await executeTool("write", { path: "../escape.txt", content: "x" });
    expect(r.isError).toBe(true);
    expect(existsSync(join(resolve(dir, ".."), "escape.txt"))).toBe(false);
  });

  it("§5.7.1：项目内的写入正常（约束不能把正常路径也挡掉）", async () => {
    const r = await executeTool("write", { path: "a.txt", content: "内容" });
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("内容");
    // 顺带钉死一个取舍：write **不**自动建父目录（不做隐式 mkdir）。
    // 要建目录就显式建——隐式创建会让"写错路径"看起来像成功。
    const nested = await executeTool("write", { path: "nope/b.txt", content: "x" });
    expect(nested.isError).toBe(true);
  });
});

describe("§4.6.2：工具执行期间 CLI 仍然活着（否则 abort 语义是空的）", () => {
  let agentDir: string;
  let cwd: string;
  let server: Server;

  beforeEach(async () => {
    agentDir = mkdtempSync(join(tmpdir(), "minimal-live-"));
    cwd = mkdtempSync(join(tmpdir(), "minimal-live-proj-"));
    // mock 模型：第一轮返回 bash 工具调用（跑 3 秒），第二轮（已带 tool 结果）返回最终文本。
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const hasTool = (parsed.messages ?? []).some((m: { role?: string }) => m.role === "tool");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (!hasTool) {
          const args = JSON.stringify({ command: "sleep 3" });
          res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","function":{"name":"bash","arguments":${JSON.stringify(args)}}}]}}]}\n\n`);
        } else {
          res.write('data: {"choices":[{"delta":{"content":"完成"}}]}\n\n');
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: [{ id: "mock", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }],
      default: { provider: "mock", model: "m" },
    }));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("bash 在跑的时候 ping 仍能即时得到 pong（事件循环没被占住）", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-live" });
    const t = new MinimalTransport(handle);
    const events: MinimalEvent[] = [];
    let sawBashStart: (() => void) | null = null;
    const bashStarted = new Promise<void>((r) => (sawBashStart = r));
    let pongAt = 0;
    const settled = new Promise<void>((resolveSettled) => {
      t.onEvent((e) => {
        events.push(e);
        if (e.type === "toolCallStart") sawBashStart?.();
        if (e.type === "pong") pongAt = Date.now();
        if (e.type === "agentSettled") resolveSettled();
      });
    });
    t.start();
    t.send({ type: "setTools", tools: "full" }); // bash 是危险工具，只在 full 集里（§5.7.2）
    t.send({ type: "send", text: "跑一条慢命令" });
    await bashStarted;

    const pingAt = Date.now();
    t.send({ type: "ping" });
    // 等 pong：同步执行时它只会在 bash 跑完（~3s）之后才到
    await new Promise<void>((r) => {
      const timer = setInterval(() => { if (pongAt) { clearInterval(timer); r(); } }, 20);
      setTimeout(() => { clearInterval(timer); r(); }, 2500);
    });
    expect(pongAt, "bash 执行期间 CLI 读不到 stdin —— §4.6.2 的 abort 语义在同步执行下不成立").toBeGreaterThan(0);
    expect(pongAt - pingAt, `pong 迟了 ${pongAt - pingAt}ms（同步执行会等到命令跑完才回）`).toBeLessThan(1500);

    await settled;
    await t.stop();
  });
});
