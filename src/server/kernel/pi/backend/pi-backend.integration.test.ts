// PiBackend 集成测试:起真实 pi 二进制,走 start → setModel → sendMessage("ping") 全链路。
// 回归「pi 内核模型 ping 成功」——与 dsh-backend.integration.test.ts 对称,验证两个内核
// 的模型连通性测试(pi set_model 命令 + dsh session/setModel)都能收到 assistant 回复。
// 需要真实 pi 二进制 + settings.json 里可用的默认模型(apps-studio key 由 pi 自身经
// models.json 的 !sqlite3 命令解析),缺二进制即跳过(不伪造成功)。
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPiBackend } from "../../factories/kernel-factories";
import type { SessionEvent } from "@my-harness-desktop/shared";

const CLI = join(homedir(), ".my-harness-desktop-dev", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

const skippable = process.env.PI_RUNTIME_E2E !== "1" || !existsSync(CLI);

describe.skipIf(skippable)("PiBackend 集成(真实 pi 二进制)", () => {
  it("模型连通性测试:setModel + ping 收到 assistant 回复", async () => {
    const backend = createPiBackend({
      cwd: process.cwd(),
      agentDir: join(homedir(), ".pi"),
      kernel: "pi",
      neutralSessionId: "test-pi-session",
      ephemeral: true,
      cliPath: CLI,
    });

    const events: SessionEvent[] = [];
    const off = backend.onEvent((e) => events.push(e));

    try {
      // 1. start 含就绪探测(等 pi rpc ready)。
      await backend.start();
      // 2. setModel 发 set_model 命令(settings.json 默认模型 apps-studio/qwen3.8-max)。
      await backend.setModel("apps-studio", process.env.PI_TEST_MODEL ?? "volcengine/deepseek-v4-pro");
      // 3. 先订阅再发 ping(不竞态),等 assistant messageEnd。
      const replyPromise = new Promise<"ok" | "error">((resolve) => {
        const timer = setTimeout(() => resolve("error"), 60_000);
        const inner = backend.onEvent((event) => {
          if (event.type === "messageEnd") {
            const msg = (event as { message?: { role?: string; error?: unknown } }).message;
            if (msg?.role === "assistant" && !msg.error) { clearTimeout(timer); inner(); resolve("ok"); }
            else if (msg?.error) { clearTimeout(timer); inner(); resolve("error"); }
          } else if (event.type === "agentEnd" || event.type === "agentSettled") {
            clearTimeout(timer); inner(); resolve("error");
          }
        });
      });
      await backend.sendMessage("ping");
      const result = await replyPromise;
      expect(result).toBe("ok");
      expect(events.some((e) => e.type === "agentStart")).toBe(true);
    } finally {
      off();
      await backend.stop().catch(() => {});
    }
  }, 90_000);
});
