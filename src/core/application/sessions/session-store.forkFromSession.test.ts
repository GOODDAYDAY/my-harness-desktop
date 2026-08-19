// forkFromSession 的竞态护栏回归测试。
// 根因(勿回退):start 的 await 窗口(spawn+waitReady)内并发 setContext 切走激活态,
// fork 若经环境性 activeProc() 取进程,命令落到别的会话的 pi——entryId 不在其会话
// 文件里,底座报 "Invalid entry ID for forking";更劣变体是目标会话恰好含该 id 时
// 静默 fork 错会话。护栏:激活态丢失即中止;fork 命令钉在本次启动的 proc 上。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type BackendFactory } from "./session-store";
import { PiBackend } from "../../../client/pi/pi-backend";
import type { RpcAdapter } from "../../../client/pi/rpc-adapter";
import type { SessionCatalogFactory } from "../../domain/backend";
import { cwdToBucketName } from "../../domain/sessions";

/** 目录/CRUD 工厂桩:本测试只测 forkFromSession 编排,不碰目录。 */
const catalogFactory: SessionCatalogFactory = {
  create: () => ({
    kernel: "pi" as const,
    list: async () => [],
    open: async () => null,
    rename: async () => {},
    updateHeader: async () => {},
    deleteSessions: async () => {},
    copy: async () => {},
    readToolConfig: async () => null,
    readCustom: async () => null,
    getTree: async () => ({ rootId: "", lineages: [] }),
    bookmark: (_cwd: string, lineageId: string, boundary: string) => ({ lineageId, boundary, opaque: "" }),
    deleteBookmark: () => {},
    contextProbeTokens: () => null,
    projectStats: async () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, sessionCount: 0, turns: 0 }),
  }),
};

/** 假 RpcAdapter:应答 waitReady/sync 的四命令;fork 按剧本走。记录全部已收命令。 */
class FakeAdapter {
  alive = false;
  stderr = "";
  readonly sent: { type?: string }[] = [];
  sessionFile: string | null = null;
  /** fork 剧本:success=把 sessionFile 切到 forkProduct(模拟底座分叉);stall=不切(未生效);cancelled=扩展取消。 */
  forkScript: "success" | "stall" | "cancelled" = "success";
  forkProduct: string | null = null;
  /** start 挂起闸门:模拟 spawn+waitReady 的 await 窗口。 */
  startHeld = false;
  private startRelease: (() => void) | null = null;

  onEvent(_cb: unknown): void {}
  onBusFrame(_cb: unknown): void {}
  onExtensionUI(_cb: unknown): void {}
  onProcessExit: unknown = null;

  async start(): Promise<void> {
    if (this.startHeld) await new Promise<void>((r) => { this.startRelease = r; });
    this.alive = true;
  }
  releaseStart(): void {
    this.startRelease?.();
    this.startRelease = null;
  }
  async stop(): Promise<void> {
    this.alive = false;
  }
  async send(cmd: { type?: string }): Promise<unknown> {
    this.sent.push(cmd);
    const ok = (data: unknown) => ({ type: "response", success: true, data });
    switch (cmd.type) {
      case "get_state": return ok({ sessionFile: this.sessionFile });
      case "get_entries": return ok({ entries: [], leafId: null });
      case "get_tree": return ok({ tree: [], leafId: null });
      case "get_commands": return ok({ commands: [] });
      case "fork": {
        if (this.forkScript === "cancelled") return ok({ cancelled: true });
        if (this.forkScript === "success") this.sessionFile = this.forkProduct;
        return ok({ cancelled: false });
      }
      default: return ok({});
    }
  }
}

/** factory:create 时按 sessionId 实参初始化假底座的会话文件(模拟底座加载该文件)。 */
function makeFactory(adapter: FakeAdapter): BackendFactory {
  return {
    create: (opts) => {
      adapter.sessionFile = opts.sessionId ?? null;
      return new PiBackend(adapter as unknown as RpcAdapter, { cwd: opts.cwd, agentDir: opts.agentDir });
    },
  };
}

describe("forkFromSession", () => {
  let root: string;
  let agentDir: string;
  let srcPath: string;
  const cwd = "/tmp/fork-test-project";

  const bucketDir = (): string => join(agentDir, "sessions", cwdToBucketName(cwd));
  const bucketFiles = (): string[] => {
    try {
      return readdirSync(bucketDir());
    } catch {
      return [];
    }
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fork-from-session-"));
    agentDir = join(root, "agent");
    mkdirSync(join(root, "src"), { recursive: true });
    srcPath = join(root, "src", "bookmark-copy.jsonl");
    writeFileSync(srcPath, [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-08-06T00:00:00.000Z", cwd }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-08-06T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
    ].join("\n") + "\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("happy path:fork 钉在中间副本的进程上,对账切到产物,删中间副本", async () => {
    const adapter = new FakeAdapter();
    const store = new SessionStore(makeFactory(adapter), catalogFactory, agentDir);
    const announced: string[] = [];
    // SessionEvent 联合末尾的宽松兑底成员使判别不窄化,与 store 内同一手法显式收窄
    store.onEvent((e) => { if (e.type === "sessionStart") announced.push((e as { sessionFile?: string }).sessionFile ?? ""); });
    adapter.forkProduct = join(bucketDir(), "forked-product.jsonl");

    await store.forkFromSession(cwd, srcPath, "e1", "at");

    const forks = adapter.sent.filter((c) => c.type === "fork");
    expect(forks).toHaveLength(1);
    expect(bucketFiles()).toHaveLength(0); // 中间副本已删(假底座不落产物文件)
    expect(announced.length).toBeGreaterThan(0);
    expect(announced[announced.length - 1]).toBe(adapter.forkProduct); // 激活态切到产物
  });

  it("竞态:start 窗口内并发 setContext 切走——中止,fork 命令零发出,不拽回用户上下文", async () => {
    const adapter = new FakeAdapter();
    adapter.startHeld = true;
    const store = new SessionStore(makeFactory(adapter), catalogFactory, agentDir);
    const announced: string[] = [];
    // SessionEvent 联合末尾的宽松兑底成员使判别不窄化,与 store 内同一手法显式收窄
    store.onEvent((e) => { if (e.type === "sessionStart") announced.push((e as { sessionFile?: string }).sessionFile ?? ""); });

    const p = store.forkFromSession(cwd, srcPath, "e1", "at");
    // forkFromSession 同步段已完(setContext+createProc+adapter.start 挂起中)——
    // 模拟用户此刻点了会话列表里别的会话
    const other = join(agentDir, "sessions", "other.jsonl");
    store.setContext(cwd, other);
    adapter.releaseStart();

    await expect(p).rejects.toThrow("并发上下文切换打断");
    expect(adapter.sent.filter((c) => c.type === "fork")).toHaveLength(0); // fork 零发出
    expect(bucketFiles()).toHaveLength(0); // 中间副本已清
    expect(adapter.alive).toBe(false); // 中间副本的进程已停
    expect(announced[announced.length - 1]).toBe(other); // 不拽回先前上下文
  });

  it("fork 响应 success 但底座未切换(未生效):报'fork 未生效'并回滚", async () => {
    const adapter = new FakeAdapter();
    adapter.forkScript = "stall";
    const store = new SessionStore(makeFactory(adapter), catalogFactory, agentDir);

    await expect(store.forkFromSession(cwd, srcPath, "e1", "at")).rejects.toThrow("fork 未生效");
    expect(bucketFiles()).toHaveLength(0);
    expect(adapter.alive).toBe(false);
    expect(store.alive).toBe(false); // 上下文已恢复(prevPath=null → 无激活进程)
  });

  it("fork 被底座扩展取消:报取消并回滚,不留孤儿", async () => {
    const adapter = new FakeAdapter();
    adapter.forkScript = "cancelled";
    const store = new SessionStore(makeFactory(adapter), catalogFactory, agentDir);

    await expect(store.forkFromSession(cwd, srcPath, "e1", "at")).rejects.toThrow("fork 被取消");
    expect(bucketFiles()).toHaveLength(0);
    expect(adapter.alive).toBe(false);
    expect(store.alive).toBe(false);
  });
});
