// session-scanner 头行私有数据统一存储裸单测:desktop 私有数据全落 custom-my-harness-desktop,
// name 单轨 session_info(设计 docs/design/session-header-custom.md 2026-08-06 修订、
// docs/design/session-name-tracks.md §7)。fixture:tmp 目录真会话文件,纯文件操作不 mock。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  piUpdateSessionHeader as updateSessionHeader, piReadSession as readSession,
  piReadSessionName as readSessionName, piReadSessionHeader as readSessionHeader,
  piReadSessionCustom as readSessionCustom, piReadSessionToolConfig as readSessionToolConfig,
  piListSessions as listSessions, piReadSessionEntries as readSessionEntries,
  PiSessionCatalog,
} from "./pi-catalog";
import { cwdToBucketName } from "@my-harness-desktop/shared";

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

describe("pinned/archived/toolConfig 落 custom-my-harness-desktop 保留键", () => {
  it("写入后落命名空间顶层,头行不再有顶层私有字段", async () => {
    await updateSessionHeader(sessionPath, { pinned: true, archived: true, toolConfig: { enabledToolIds: ["read"] } });
    const header = headerOf(sessionPath);
    expect(header.pinned).toBeUndefined();
    expect(header.archived).toBeUndefined();
    expect(header.toolConfig).toBeUndefined();
    const custom = header["custom-my-harness-desktop"] as Record<string, unknown>;
    expect(custom.pinned).toBe(true);
    expect(custom.archived).toBe(true);
    expect(custom.toolConfig).toEqual({ enabledToolIds: ["read"] });
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
    await updateSessionHeader(sessionPath, { pinned: true, toolConfig: { enabledGroupIds: [], enabledToolIds: [] } });
    await updateSessionHeader(sessionPath, { pinned: false, toolConfig: null });
    const header = headerOf(sessionPath);
    expect(header["custom-my-harness-desktop"]).toBeUndefined();
  });

  it("readSessionToolConfig 经 custom-my-harness-desktop 窄化读", async () => {
    await updateSessionHeader(sessionPath, { toolConfig: { enabledToolIds: ["bash"] } });
    expect(readSessionToolConfig(sessionPath)).toEqual({ enabledToolIds: ["bash"] });
    await updateSessionHeader(sessionPath, { toolConfig: null });
    expect(readSessionToolConfig(sessionPath)).toBeNull();
  });
});

describe("name 单轨 session_info", () => {
  it("name-only 补丁只追加 session_info,头行不落 name", async () => {
    await updateSessionHeader(sessionPath, { name: "我的会话" });
    const header = headerOf(sessionPath);
    expect(header.name).toBeUndefined();
    expect(header["custom-my-harness-desktop"]).toBeUndefined();
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
    expect(headerOf(sessionPath)["custom-my-harness-desktop"]).toBeUndefined();
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

describe("readSession 统计:上下文锚点只认测到 prompt 的 usage", () => {
  const msgEntry = (id: string, parentId: string | null, message: Record<string, unknown>) => ({
    type: "message", id, parentId, timestamp: "2026-08-06T00:00:00.000Z", message,
  });
  const assistantUsage = (id: string, parentId: string | null, usage: Record<string, unknown>) =>
    msgEntry(id, parentId, { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage });

  it("健康 usage(input/cache 有值)→ 锚点取末条 totalTokens", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "user", content: "hi" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(assistantUsage("b", "a", { input: 400, output: 200, cacheRead: 300, cacheWrite: 100, totalTokens: 1000 })) + "\n", { flag: "a" });
    expect(readSession(sessionPath)?.stats?.contextUsage?.tokens).toBe(1000);
  });

  it("坏 usage(prompt 全 0,只有 output)→ 诚实未知(回归:36 条消息显示 2)", () => {
    // 真实事故:供应商不上报 prompt token,totalTokens 只是输出量
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "user", content: "问题" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(assistantUsage("b", "a", { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 2 })) + "\n", { flag: "a" });
    expect(readSession(sessionPath)?.stats?.contextUsage).toBeUndefined();
  });

  it("混合:坏锚点跳过,向前落最近一条健康锚点", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "user", content: "hi" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(assistantUsage("b", "a", { input: 4000, output: 500, cacheWrite: 500, totalTokens: 5000 })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(assistantUsage("c", "b", { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 2 })) + "\n", { flag: "a" });
    // 5000(健康锚点) + 1(trailing:坏锚点消息 text "ok" 的 chars/4 估算)——与底座 estimateContextTokens 同算法
    expect(readSession(sessionPath)?.stats?.contextUsage?.tokens).toBe(5001);
  });
});

describe("readSession 统计:与底座 getSessionStats 同口径", () => {
  const msgEntry = (id: string, parentId: string | null, message: Record<string, unknown>) => ({
    type: "message", id, parentId, timestamp: "2026-08-06T00:00:00.000Z", message,
  });
  const healthy = (id: string, parentId: string | null, totalTokens: number) =>
    msgEntry(id, parentId, { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: totalTokens - 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { total: 0.01 } } });

  it("total 现算四项和,不依赖文件里 totalTokens 字段在场", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "user", content: "hi" })) + "\n", { flag: "a" });
    // totalTokens 缺失:旧口径 total=0,底座口径 total=四项和
    writeFileSync(sessionPath, JSON.stringify(msgEntry("b", "a", { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 300, output: 200, cacheRead: 400, cacheWrite: 100, cost: { total: 0.01 } } })) + "\n", { flag: "a" });
    const stats = readSession(sessionPath)?.stats;
    expect(stats?.tokens.total).toBe(1000);
  });

  it("toolResult 与 compaction entry 的 usage 计入累计(底座三入口)", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "user", content: "hi" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(healthy("b", "a", 1000)) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(msgEntry("c", "b", { role: "toolResult", content: "r", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0.001 } } })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify({ type: "compaction", id: "d", parentId: "c", timestamp: "2026-08-06T00:01:00.000Z", summary: "摘要", usage: { input: 50, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { total: 0.002 } } }) + "\n", { flag: "a" });
    const stats = readSession(sessionPath)?.stats;
    expect(stats?.tokens.total).toBe(1000 + 30 + 100);
    expect(stats?.cost).toBeCloseTo(0.013);
  });

  it("压缩后无新锚点 → tokens: null 诚实未知(对齐底座,不冒充 0)", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "user", content: "hi" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(healthy("b", "a", 9000)) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify({ type: "compaction", id: "c", parentId: "b", timestamp: "2026-08-06T00:01:00.000Z", summary: "压缩摘要" }) + "\n", { flag: "a" });
    const ctx = readSession(sessionPath)?.stats?.contextUsage;
    expect(ctx?.tokens).toBeNull();
    expect(ctx?.percent).toBeNull();
  });

  it("压缩后有新锚点 → 压缩前锚点废弃,新锚点 + trailing", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "user", content: "hi" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(healthy("b", "a", 9000)) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify({ type: "compaction", id: "c", parentId: "b", timestamp: "2026-08-06T00:01:00.000Z", summary: "压缩摘要" }) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(msgEntry("d", "c", { role: "user", content: "接着问" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(healthy("e", "d", 2000)) + "\n", { flag: "a" });
    const ctx = readSession(sessionPath)?.stats?.contextUsage;
    expect(ctx?.tokens).toBe(2000); // 不落 9000;锚点即末条,trailing=0
  });

  it("aborted/error 的 assistant usage 不作锚点(底座同款排查)", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "user", content: "hi" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(msgEntry("b", "a", { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "error", usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600 } })) + "\n", { flag: "a" });
    // error 消息不作锚点,但 usage 仍计入累计(底座 addUsageToTotals 不查 stopReason)
    const stats = readSession(sessionPath)?.stats;
    expect(stats?.contextUsage).toBeUndefined();
    expect(stats?.tokens.total).toBe(600);
  });
});

describe("readSession 模型证据提取(与底座 getSessionContextSettings 同算法)", () => {
  const msgEntry = (id: string, parentId: string | null, message: Record<string, unknown>) => ({
    type: "message", id, parentId, timestamp: "2026-08-06T00:00:00.000Z", message,
  });

  it("assistant 消息的 provider/model 作证;末条胜出", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "assistant", provider: "p1", model: "m1", content: [{ type: "text", text: "x" }], stopReason: "stop" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify(msgEntry("b", "a", { role: "assistant", provider: "p2", model: "m2", content: [{ type: "text", text: "y" }], stopReason: "stop" })) + "\n", { flag: "a" });
    expect(readSession(sessionPath)?.modelEvidence).toEqual({ provider: "p2", modelId: "m2" });
  });

  it("model_change 条目作证;与 assistant 证据按文件序末条胜出", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "assistant", provider: "p1", model: "m1", content: [{ type: "text", text: "x" }], stopReason: "stop" })) + "\n", { flag: "a" });
    writeFileSync(sessionPath, JSON.stringify({ type: "model_change", id: "c", parentId: "a", timestamp: "2026-08-06T00:01:00.000Z", provider: "p3", modelId: "m3" }) + "\n", { flag: "a" });
    expect(readSession(sessionPath)?.modelEvidence).toEqual({ provider: "p3", modelId: "m3" });
  });

  it("无证据(只有 user 消息)→ undefined", () => {
    writeFileSync(sessionPath, JSON.stringify(msgEntry("a", null, { role: "user", content: "hi" })) + "\n", { flag: "a" });
    expect(readSession(sessionPath)?.modelEvidence).toBeUndefined();
  });
});

describe("piReadSessionEntries 逐 lineage 读独有条目(增量语义)", () => {
  function entry(id: string, parentId: string | null, text: string): string {
    return JSON.stringify({ type: "message", id, parentId, message: { role: "user", content: text } });
  }

  it("根 lineage(无锚点)= 沿首子走到底", () => {
    const p = join(agentDir, "tree.jsonl");
    writeFileSync(p, [
      JSON.stringify({ type: "session", id: "s" }),
      entry("a", null, "A"),
      entry("b", "a", "B"),
      entry("c", "b", "C"), // b 的首子
      entry("d", "b", "D"), // b 的第二个子(分支)
    ].join("\n") + "\n");
    const msgs = readSessionEntries(p);
    expect(msgs.map((m) => m.content)).toEqual(["A", "B", "C"]);
  });

  it("分支 lineage(锚点)= 从锚点沿首子走(独有条目)", () => {
    const p = join(agentDir, "tree2.jsonl");
    writeFileSync(p, [
      JSON.stringify({ type: "session", id: "s" }),
      entry("a", null, "A"),
      entry("b", "a", "B"),
      entry("c", "b", "C"),
      entry("d", "b", "D"), // 分支锚点
      entry("e", "d", "E"), // d 的首子
    ].join("\n") + "\n");
    const msgs = readSessionEntries(p, "d");
    expect(msgs.map((m) => m.content)).toEqual(["D", "E"]);
  });
});

describe("rawFilePath(打开原始文件的唯一权威来源)", () => {
  it("投影文件存在 → 返回真实磁盘路径", () => {
    // beforeEach 的 s1.jsonl 恰好落在投影规则 <bucket>/<lineageId>.jsonl 上
    const catalog = new PiSessionCatalog(agentDir);
    expect(catalog.rawFilePath(CWD, "s1")).toBe(join(agentDir, "sessions", cwdToBucketName(CWD), "s1.jsonl"));
  });

  it("投影文件不存在(迁移前旧会话无投影)→ null,不返回幽灵地址", () => {
    const catalog = new PiSessionCatalog(agentDir);
    expect(catalog.rawFilePath(CWD, "no-such-lineage")).toBeNull();
  });
});
