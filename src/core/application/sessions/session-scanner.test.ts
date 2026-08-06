// session-scanner 头行私有数据统一存储裸单测:desktop 私有数据全落 custom-pi-desktop,
// name 单轨 session_info(设计 docs/design/session-header-custom.md 2026-08-06 修订、
// docs/design/session-name-tracks.md §7)。fixture:tmp 目录真会话文件,纯文件操作不 mock。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  updateSessionHeader, readSession, readSessionName, readSessionHeader,
  readSessionCustom, readSessionToolConfig, listSessions,
} from "./session-scanner";
import { cwdToBucketName } from "../../domain/sessions";

const CWD = "/tmp/proj";
let agentDir: string;
let sessionPath: string;

function headerOf(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8").split("\n")[0]) as Record<string, unknown>;
}

function linesOf(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "session-scanner-unify-"));
  const bucket = join(agentDir, "sessions", cwdToBucketName(CWD));
  mkdirSync(bucket, { recursive: true });
  sessionPath = join(bucket, "s1.jsonl");
  writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s1", cwd: CWD, timestamp: "2026-08-06T00:00:00.000Z" }) + "\n");
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("pinned/archived/toolConfig 落 custom-pi-desktop 保留键", () => {
  it("写入后落命名空间顶层,头行不再有顶层私有字段", async () => {
    await updateSessionHeader(sessionPath, { pinned: true, archived: true, toolConfig: { mode: "custom", enabledToolIds: ["read"] } });
    const header = headerOf(sessionPath);
    expect(header.pinned).toBeUndefined();
    expect(header.archived).toBeUndefined();
    expect(header.toolConfig).toBeUndefined();
    const custom = header["custom-pi-desktop"] as Record<string, unknown>;
    expect(custom.pinned).toBe(true);
    expect(custom.archived).toBe(true);
    expect(custom.toolConfig).toEqual({ mode: "custom", enabledToolIds: ["read"] });
  });

  it("readSession/listSessions 读回 SessionInfo 透传字段", async () => {
    await updateSessionHeader(sessionPath, { pinned: true });
    const detail = readSession(sessionPath);
    expect(detail?.info.pinned).toBe(true);
    expect(detail?.info.archived).toBe(false);
    const list = listSessions(agentDir, CWD);
    expect(list).toHaveLength(1);
    expect(list[0].pinned).toBe(true);
    expect(list[0].archived).toBe(false);
  });

  it("false/null 删键,删光后命名空间不留空壳", async () => {
    await updateSessionHeader(sessionPath, { pinned: true, toolConfig: { mode: "all" } });
    await updateSessionHeader(sessionPath, { pinned: false, toolConfig: null });
    const header = headerOf(sessionPath);
    expect(header["custom-pi-desktop"]).toBeUndefined();
  });

  it("readSessionToolConfig 经 custom-pi-desktop 窄化读", async () => {
    await updateSessionHeader(sessionPath, { toolConfig: { mode: "custom", enabledToolIds: ["bash"] } });
    expect(readSessionToolConfig(sessionPath)).toEqual({ mode: "custom", enabledToolIds: ["bash"] });
    await updateSessionHeader(sessionPath, { toolConfig: null });
    expect(readSessionToolConfig(sessionPath)).toBeNull();
  });
});

describe("name 单轨 session_info", () => {
  it("name-only 补丁只追加 session_info,头行不落 name", async () => {
    await updateSessionHeader(sessionPath, { name: "我的会话" });
    const header = headerOf(sessionPath);
    expect(header.name).toBeUndefined();
    expect(header["custom-pi-desktop"]).toBeUndefined();
    const entries = linesOf(sessionPath);
    const info = entries.filter((e) => e.type === "session_info");
    expect(info).toHaveLength(1);
    expect(info[0].name).toBe("我的会话");
    expect(readSessionName(sessionPath)).toBe("我的会话");
  });

  it("空名 = 显式清除:追加空名条目,读取返回 undefined", async () => {
    await updateSessionHeader(sessionPath, { name: "旧名" });
    await updateSessionHeader(sessionPath, { name: "" });
    expect(readSessionName(sessionPath)).toBeUndefined();
    const info = linesOf(sessionPath).filter((e) => e.type === "session_info");
    expect(info).toHaveLength(2);
    expect(info[1].name).toBe("");
  });

  it("头行遗留 name 字段不再被读(无兜底)", async () => {
    writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s1", cwd: CWD, name: "遗留名" }) + "\n");
    expect(readSessionName(sessionPath)).toBeUndefined();
    expect(readSession(sessionPath)?.info.name).toBeUndefined();
  });

  it("readSession 名字以最后一条 session_info 为准", async () => {
    await updateSessionHeader(sessionPath, { name: "第一版" });
    await updateSessionHeader(sessionPath, { name: "第二版" });
    expect(readSession(sessionPath)?.info.name).toBe("第二版");
  });
});

describe("custom 域与保留键共处一个命名空间", () => {
  it("custom 域浅合并与保留键互不覆盖", async () => {
    await updateSessionHeader(sessionPath, { pinned: true });
    await updateSessionHeader(sessionPath, { custom: { subagent: { parent_id: "main" } } });
    const custom = readSessionCustom(sessionPath);
    expect(custom?.pinned).toBe(true);
    expect(custom?.subagent).toEqual({ parent_id: "main" });
  });

  it("custom:null 清空整个命名空间(含保留键)", async () => {
    await updateSessionHeader(sessionPath, { pinned: true, custom: { subagent: { parent_id: "main" } } });
    await updateSessionHeader(sessionPath, { custom: null });
    expect(readSessionCustom(sessionPath)).toBeNull();
    expect(headerOf(sessionPath)["custom-pi-desktop"]).toBeUndefined();
  });

  it("{k:null} 删单个域,保留键不动", async () => {
    await updateSessionHeader(sessionPath, { pinned: true, custom: { subagent: { parent_id: "main" } } });
    await updateSessionHeader(sessionPath, { custom: { subagent: null } });
    const custom = readSessionCustom(sessionPath);
    expect(custom?.pinned).toBe(true);
    expect(custom?.subagent).toBeUndefined();
  });
});

describe("readSessionHeader 通用头行读", () => {
  it("返回头行 JSON;文件缺失返回 null", () => {
    const header = readSessionHeader(sessionPath);
    expect(header?.type).toBe("session");
    expect(header?.id).toBe("s1");
    expect(readSessionHeader(join(agentDir, "不存在.jsonl"))).toBeNull();
  });
});

// ============ 文件基线统计对齐底座口径(设计 session-stats-alignment.md §2/§3)============

/** 追加一条 JSONL entry(真实文件 IO,与 readSession 的消费路径一致)。 */
function appendEntry(e: Record<string, unknown>): void {
  writeFileSync(sessionPath, JSON.stringify(e) + "\n", { flag: "a" });
}
const userMsg = (id: string, parentId: string | null, content: string) => ({
  type: "message", id, parentId, timestamp: "2026-08-06T00:00:00.000Z",
  message: { role: "user", content },
});
const assistantMsg = (id: string, parentId: string | null, totalTokens: number) => ({
  type: "message", id, parentId, timestamp: "2026-08-06T00:00:00.000Z",
  message: {
    role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop",
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens },
  },
});

describe("readSession 统计:分支感知 contextUsage + totalMessages 全量计数", () => {
  it("线性会话:contextUsage = 末条 usage + 尾随估算", () => {
    appendEntry(userMsg("a", null, "hi"));
    appendEntry(assistantMsg("b", "a", 1000));
    appendEntry(userMsg("c", "b", "12345678")); // 8 字符 → 2 token 尾随
    const stats = readSession(sessionPath)?.stats;
    expect(stats?.contextUsage?.tokens).toBe(1002);
    expect(stats?.contextUsage?.contextWindow).toBe(0);
    expect(stats?.contextUsage?.percent).toBeNull();
  });

  it("分支会话:leaf=文件末条,废弃分支不进上下文", () => {
    appendEntry(userMsg("a", null, "hi"));
    appendEntry(assistantMsg("b", "a", 1000));
    appendEntry(userMsg("c", "b", "x".repeat(40000))); // 废弃分支:若误入会 +10000
    appendEntry(userMsg("d", "b", "12345678"));        // 激活分支(末条 = leaf)
    const stats = readSession(sessionPath)?.stats;
    expect(stats?.contextUsage?.tokens).toBe(1002); // 1000 + 2,废弃分支 c 被排除
  });

  it("compaction 后无有效 usage → tokens 诚实 null(未知,非 0)", () => {
    appendEntry(userMsg("a", null, "hi"));
    appendEntry(assistantMsg("b", "a", 5000));
    appendEntry({ type: "compaction", id: "cp", parentId: "b", timestamp: "2026-08-06T00:00:00.000Z", summary: "摘要", tokensBefore: 5000 });
    appendEntry(userMsg("c", "cp", "压缩后的新问题"));
    const stats = readSession(sessionPath)?.stats;
    expect(stats?.contextUsage?.tokens).toBeNull();
  });

  it("compaction 后有 usage:锚点取边界后,旧上下文不混入", () => {
    appendEntry(userMsg("a", null, "hi"));
    appendEntry(assistantMsg("b", "a", 5000));
    appendEntry({ type: "compaction", id: "cp", parentId: "b", timestamp: "2026-08-06T00:00:00.000Z", summary: "摘要", tokensBefore: 5000 });
    appendEntry(userMsg("c", "cp", "问"));
    appendEntry(assistantMsg("d", "c", 800));
    const stats = readSession(sessionPath)?.stats;
    expect(stats?.contextUsage?.tokens).toBe(800);
  });

  it("totalMessages 数全部 type=message(含 custom role),对齐底座 getSessionStats", () => {
    appendEntry(userMsg("a", null, "hi"));
    appendEntry(assistantMsg("b", "a", 100));
    appendEntry({
      type: "message", id: "c", parentId: "b", timestamp: "2026-08-06T00:00:00.000Z",
      message: { role: "custom", content: "自定义角色消息" },
    });
    const stats = readSession(sessionPath)?.stats;
    expect(stats?.totalMessages).toBe(3);   // user + assistant + custom
    expect(stats?.userMessages).toBe(1);
    expect(stats?.assistantMessages).toBe(1);
  });

  it("累计类统计仍走全量序列(废弃分支的消耗也计入 tokens/cost)", () => {
    appendEntry(userMsg("a", null, "hi"));
    appendEntry(assistantMsg("b", "a", 1000)); // usage: input10 output20 cacheRead30 cacheWrite40
    appendEntry(assistantMsg("c", "b", 2000)); // 废弃分支上的 assistant
    appendEntry(userMsg("d", "b", "激活分支")); // leaf → c 不在激活路径上
    const stats = readSession(sessionPath)?.stats;
    expect(stats?.tokens.input).toBe(20);
    expect(stats?.tokens.output).toBe(40);
    expect(stats?.tokens.total).toBe(3000); // 1000 + 2000,全量累加不分分支
    // contextUsage 仍只算激活分支:1000 + "激活分支"4 字符估算
    expect(stats?.contextUsage?.tokens).toBe(1001);
  });
});
