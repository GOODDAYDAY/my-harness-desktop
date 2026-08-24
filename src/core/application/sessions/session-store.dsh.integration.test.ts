// SessionStore → dsh 全链路集成测试(真机):setModel(dsh) → prompt → 收到 assistant 回复。
// 复现「会话未启动」的发送路径:确认 prompt 不抛错、消息经真实 dsh 后端发出并收到回复。
// 需要真实 dsh 二进制 + cordis.yml + us-new key,三者缺一即跳过(不伪造成功)。
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { SessionStore, type BackendFactory } from "./session-store";
import { createDshBackend } from "../../../bootstrap/kernel/kernel-factories";
import type { SessionCatalogFactory } from "../../domain/backend";

const CLI = join(homedir(), ".my-harness-desktop-dev", "dsh", "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo", "lib", "bin.js");
const CORDIS = join(homedir(), ".dsh", "cordis.yml");
const CWD = "/Users/anker/anker/bots-gdc";

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
  } catch { /* ignore */ }
  return undefined;
}

const skippable = process.env.DSH_RUNTIME_E2E !== "1" || !existsSync(CLI) || !existsSync(CORDIS) || resolveApiKey() === undefined;

describe.skipIf(skippable)("SessionStore → dsh 全链路(真机)", () => {
  it("setModel(dsh) → prompt 收到 assistant 回复(会话未启动回归)", async () => {
    const factory: BackendFactory = {
      create: (opts) => createDshBackend({
        ...opts,
        provider: "us-new",
        model: "bifrost/tencent/deepseek-v4-pro",
        cliPath: CLI,
        cordisConfig: CORDIS,
        env: { US_NEW_API_KEY: resolveApiKey()! },
      }),
      seed: async () => null,
    };
    // dsh 惰性会话:newSessionId 返回 null;本次路径只触达它。
    const catalogFactory: SessionCatalogFactory = {
      create: () => ({ kernel: "dsh", newSessionId: () => null }) as unknown as ReturnType<SessionCatalogFactory["create"]>,
    };
    const store = new SessionStore(factory, catalogFactory, join(homedir(), ".pi"));

    const gotReply = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 60_000);
      const off = store.onEvent((ev) => {
        if (ev.type === "messageEnd") {
          const m = (ev as { message?: { role?: string; error?: unknown } }).message;
          if (m?.role === "assistant" && !m.error) { clearTimeout(timer); off(); resolve(true); }
        }
      });
    });

    store.setContext(CWD, null);
    await store.setModel("us-new", "bifrost/tencent/deepseek-v4-pro", "dsh");
    // 关键回归断言:prompt 不抛「会话未启动」。
    await expect(store.prompt("ping")).resolves.toBeUndefined();
    expect(await gotReply).toBe(true);
  }, 90_000);
});
