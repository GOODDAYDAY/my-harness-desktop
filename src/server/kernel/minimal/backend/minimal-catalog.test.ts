// minimal 目录/CRUD 投影单测 —— rename 追加 session_info、deleteSessions 回收文件。
//
// 依据 docs/design/minimal-kernel.md §3.3.3 / §3.4.1。测的是「非活会话」改名/删除时,
// minimal 私有文件与中立层的投影一致性——此前 rename/deleteSessions 是 no-op(投影缺失
// + 文件泄漏),本轮收口。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimalCatalog, minimalSeedSession, minimalEntryToNeutral } from "./minimal-catalog";

let agentDir: string;
let cwd: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-cat-"));
  cwd = join(tmpdir(), "minimal-project");
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function seedAndPath(ns: string): string {
  return minimalSeedSession(agentDir, cwd, [{ neutralEntryId: `${ns}:0`, message: { role: "user", content: "历史" } }], {
    lineageId: ns, header: { kernel: "minimal", cwd, createdAt: new Date().toISOString() },
  });
}

describe("MinimalCatalog 投影", () => {
  it("newSessionId 预生成派生路径(文件态内核,非惰性 null)", () => {
    const catalog = new MinimalCatalog(agentDir);
    const id = catalog.newSessionId(cwd);
    // 文件态内核与 pi 同:newSessionId 返派生路径(文件名 = 新 ns),非 null(惰性 = dsh 语义)。
    expect(id).not.toBeNull();
    expect(id).toContain(".jsonl");
    // 派生路径与 projectionPath 同源(同一 cwd/lineage 得同一路径)。
    const lineage = id!.split("/").pop()!.replace(/\.jsonl$/, "");
    expect(catalog.projectionPath(cwd, lineage)).toBe(id);
  });

  it("rename 追加 session_info 条目(非活会话改名投影)", async () => {
    const path = seedAndPath("ns-rename");
    const catalog = new MinimalCatalog(agentDir);
    await catalog.rename(path, "新名字");
    const lines = readFileSync(path, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    const info = lines.find((l) => l.type === "session_info");
    expect(info?.name).toBe("新名字");
    // 头行当前值快照同步更新(§3.3.1/§4.10.1)。
    expect(lines[0].name).toBe("新名字");
    // 投影可读回:session_info → divider kind:"info"。
    const neutral = minimalEntryToNeutral(info);
    expect(neutral?.role).toBe("divider");
    expect(neutral?.kind).toBe("info");
  });

  it("rename 对未物化会话(文件不存在)跳过,不建空文件", async () => {
    const catalog = new MinimalCatalog(agentDir);
    const ghostPath = join(agentDir, "sessions", "ghost", "ns-ghost.jsonl");
    await catalog.rename(ghostPath, "名");
    expect(existsSync(ghostPath)).toBe(false);
  });

  it("updateHeader 翻译 toolConfig → 工具集(§5.6.1)", async () => {
    const path = seedAndPath("ns-toolcfg");
    const catalog = new MinimalCatalog(agentDir);
    await catalog.updateHeader(path, { toolConfig: { enabledToolIds: ["read", "list", "write"] } });
    const header = JSON.parse(readFileSync(path, "utf-8").split("\n")[0]);
    expect(header.tools).toBe("write"); // write 档(bash 不在 → 非 full)
    await catalog.updateHeader(path, { toolConfig: { enabledToolIds: ["read", "list", "write", "bash"] } });
    expect(JSON.parse(readFileSync(path, "utf-8").split("\n")[0]).tools).toBe("full"); // bash → full
    // 写读对称:readToolConfig 反向映射回 enabledToolIds(§5.6.1 读回)
    const readBack = await catalog.readToolConfig(path);
    expect(readBack?.enabledToolIds).toEqual(["read", "list", "write", "bash"]);
  });

  it("deleteSessions 回收文件(私有文件同步删除)", async () => {
    const path = seedAndPath("ns-del");
    expect(existsSync(path)).toBe(true);
    const catalog = new MinimalCatalog(agentDir);
    await catalog.deleteSessions([path]);
    expect(existsSync(path)).toBe(false);
  });
});
