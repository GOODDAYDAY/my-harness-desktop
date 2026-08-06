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
