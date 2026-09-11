// minimal 模型调用的**空闲超时**守卫 —— 文档 §4.7.1 把"超时/重连/中断"列成客户端必须处理的三件事，
// 并点明后果："没有它们，一个卡住的模型调用会永远占住 minimal 的进程"。
//
// 此前只做了**中断**（signal）没做**超时**：服务端接了连接却不发数据、或流发到一半不动了，
// `reader.read()` 就永远挂着 → 这一回合永不收敛（`agentSettled` 永不发）→ 壳侧"运行中"永远转，
// 用户只能手动 abort 才解得开。这与工具侧那次（同步执行让超时无从触发）是**同一类**缺口：
// 文档写了"必须"，代码里没有。
//
// 本文件钉四件事：
//   ① 连上就不说话 → 按空闲超时失败（不是永远挂着）；
//   ② 流到一半不动 → 同样失败；
//   ③ **超时不能被记成"用户停止"**（§4.6.2 把 stopped 与 error 的语义钉死过）——
//      所以模型客户端**不能**去 abort 调用方的 controller；
//   ④ 正常流不受影响（连发多帧、每帧重置计时）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error 内核侧 .mjs 无类型声明（纯 JS 进内核进程，不经 TS 构建）
import { streamModel, MODEL_IDLE_TIMEOUT_MS } from "../kernel/minimal-model.mjs";

let agentDir: string;
let server: Server | null = null;

const config = (port: number) => ({
  providers: [{ id: "mock", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }],
  default: { provider: "mock", model: "m" },
});

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-mto-"));
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  rmSync(agentDir, { recursive: true, force: true });
});

/** 起一个"行为可控"的假网关。 */
async function startServer(handler: (res: import("node:http").ServerResponse) => void): Promise<number> {
  server = createServer((_req, res) => handler(res));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

describe("模型调用空闲超时（§4.7.1：超时是必须的）", () => {
  it("★ 连上就不发任何数据 → 到点失败，而不是永远挂着", async () => {
    const port = await startServer((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // 故意不写任何字节、也不结束 —— 模拟"上游卡死"
    });
    const t0 = Date.now();
    await expect(
      streamModel(config(port), agentDir, "mock", "m", [], [], { idleTimeoutMs: 300 }).catch((e: Error) => { throw e; }),
    ).rejects.toThrow(/模型调用超时/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("★ 流到一半不再动 → 同样失败（已有内容丢失可接受，回合必须收敛）", async () => {
    const port = await startServer((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n');
      // 之后不再写、也不 end
    });
    await expect(streamModel(config(port), agentDir, "mock", "m", [], [], { idleTimeoutMs: 300 })).rejects.toThrow(/模型调用超时/);
  });

  it("★ 超时**不能**被当成「用户停止」：调用方的 signal 必须保持未 abort", async () => {
    const port = await startServer((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
    });
    const caller = new AbortController();
    await expect(
      streamModel(config(port), agentDir, "mock", "m", [], [], { idleTimeoutMs: 300, signal: caller.signal }),
    ).rejects.toThrow();
    // CLI 侧判据是 `controller.signal.aborted ? stopped : error`（§4.6.2）——
    // 模型客户端若图省事去 abort 调用方的 controller，这一轮会被记成"用户停止"，与事实不符。
    expect(caller.signal.aborted, "空闲超时不该把调用方的 controller 掐掉（那会把失败记成 stopped）").toBe(false);
  });

  it("正常流不受影响：多帧数据之间不断重置计时（不会被误掐）", async () => {
    const port = await startServer((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // 每 100ms 一帧、共 5 帧：总时长 500ms > 300ms 的空闲阈值，但**间隔**都小于阈值 → 不该超时
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        res.write(`data: {"choices":[{"delta":{"content":"${n}"}}]}\n\n`);
        if (n === 5) {
          clearInterval(timer);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }, 100);
    });
    const out = await streamModel(config(port), agentDir, "mock", "m", [], [], { idleTimeoutMs: 300 });
    expect(out.text).toBe("12345");
  });

  it("用户主动 abort 仍然即时生效（超时机制不影响中断）", async () => {
    const port = await startServer((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n');
    });
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 100);
    await expect(
      streamModel(config(port), agentDir, "mock", "m", [], [], { idleTimeoutMs: 60_000, signal: caller.signal }),
    ).rejects.toThrow();
    expect(caller.signal.aborted).toBe(true);
  });

  it("默认阈值是 120 秒（空闲口径，不是总时长）", () => {
    expect(MODEL_IDLE_TIMEOUT_MS).toBe(120_000);
  });
});
