// DshBackend 集成测试:起真实 dsh-jsonrpc-agent 二进制,走 start → setModel → sendMessage("ping")
// 全链路,回归「setModel 在会话创建前调用」的 unknown session no-op 修复。
//
// 需要真实 dsh 内核二进制 + cordis.yml + us-new 的 API key,三者缺一即跳过(不伪造成功)。
// 真机运行:`US_NEW_API_KEY=... vitest run dsh-backend.integration.test.ts`(或 key 落在 ~/.dsh/.credentials.yaml)。
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createDshBackend } from "../../factories/kernel-factories";
import type { SessionEvent } from "@my-harness-desktop/shared";

const CLI = join(homedir(), ".my-harness-desktop-dev", "dsh", "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo", "lib", "bin.js");
const CORDIS = join(homedir(), ".dsh", "cordis.yml");

function resolveApiKey(): string | undefined {
  const fromEnv = process.env.US_NEW_API_KEY;
  if (fromEnv) return fromEnv;
  const cred = join(homedir(), ".dsh", ".credentials.yaml");
  try {
    if (existsSync(cred)) {
      const doc = parse(readFileSync(cred, "utf8")) as Record<string, unknown>;
      const v = doc?.US_NEW_API_KEY;
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

// 缺三者(二进制/cordis/key)或未显式开启时跳过——当前安装的 dsh 运行时(0.1.1-rc.2)尚无
// session/setModel 等新方法,本集成测试会失败;待运行时追平 deepseek-harness 源码后再
// 用 DSH_RUNTIME_E2E=1 开启。
const skippable = process.env.DSH_RUNTIME_E2E !== "1"
  || !existsSync(CLI) || !existsSync(CORDIS) || resolveApiKey() === undefined;

describe.skipIf(skippable)("DshBackend 集成(真实 dsh 二进制)", () => {
  it("模型连通性测试:setModel 在会话创建前 no-op + ping 收到 assistant 回复", async () => {
    const backend = createDshBackend({
      cwd: process.cwd(),
      agentDir: join(homedir(), ".pi"),
      kernel: "dsh",
      neutralSessionId: "test-session",
      provider: "us-new",
      model: "bifrost/tencent/deepseek-v4-pro",
      ephemeral: true,
      cliPath: CLI,
      cordisConfig: CORDIS,
      env: { US_NEW_API_KEY: resolveApiKey()! },
    });

    const events: SessionEvent[] = [];
    const off = backend.onEvent((e) => events.push(e));

    try {
      // 1. start = initialize 握手(带 "no adapter registered" 瞬时重试)。
      await backend.start();
      // 2. setModel 在首个 prompt 之前调用——dsh 侧会话未创建,应被 no-op(回归修复)。
      await backend.setModel("us-new", "bifrost/tencent/deepseek-v4-pro");
      // 3. 先订阅再发 ping(不竞态),等 assistant messageEnd(或 agentSettled = 无响应)。
      let assistantContent: unknown;
      const replyPromise = new Promise<"ok" | "error">((resolve) => {
        const timer = setTimeout(() => resolve("error"), 60_000);
        const off2 = backend.onEvent((event) => {
          if (event.type === "messageEnd") {
            const msg = (event as { message?: { role?: string; error?: unknown; content?: unknown } }).message;
            if (msg?.role === "assistant" && !msg.error) {
              assistantContent = msg.content;
              clearTimeout(timer); off2(); resolve("ok");
            } else if (msg?.error) { clearTimeout(timer); off2(); resolve("error"); }
          } else if (event.type === "agentSettled") {
            clearTimeout(timer); off2(); resolve("error");
          }
        });
      });
      await backend.sendMessage("ping");
      const reply = await replyPromise;
      expect(reply).toBe("ok");
      // 内容非空:回归翻译器 payload 在 data 字段下的字段读取(读错会得到 undefined content)。
      expect(Array.isArray(assistantContent) && assistantContent.length > 0).toBe(true);
      // setModel 阶段不应把 "unknown session" 外抛成测试失败。
      expect(events.some((e) => e.type === "agentStart")).toBe(true);
    } finally {
      off();
      await backend.stop().catch(() => {});
    }
  }, 90_000);
});
