// SessionStore 快照收藏/删除裸单测(§bookmark-snapshot-fork-unify):不 spawn 后端,
// bookmark 只读中立层物化前缀写快照;deleteBookmark 删快照文件。resume 校验路径测错误分支。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store";
import { NeutralSessionStore } from "./neutral-session-store";
import { parseBookmarkSnapshot, type BackendFactory, type SessionCatalogFactory } from "@my-harness-desktop/shared";

const CWD = "/tmp/proj";
const NS_ID = "ns1";
const SESSION_PATH = `/tmp/${NS_ID}.jsonl`;

const noopFactory: BackendFactory = { create: () => { throw new Error("bookmark 测试不 spawn 后端"); } };
const noopCatalog: SessionCatalogFactory = { create: () => { throw new Error("bookmark 测试不读目录"); } };

let dir: string;
let bookmarkDir: string;
let neutralStore: NeutralSessionStore;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bookmark-store-"));
  bookmarkDir = join(dir, "bookmarks");
  neutralStore = new NeutralSessionStore(join(dir, "sessions"));
  neutralStore.put({
    neutralSessionId: NS_ID,
    header: { kernel: "pi", cwd: CWD, createdAt: "now" },
    lineages: [{
      lineageId: NS_ID,
      fork: null,
      entries: [
        { neutralEntryId: "ns1:0", kernelEntryId: "k0", message: { role: "user", content: "hi" } },
        { neutralEntryId: "ns1:1", kernelEntryId: "k1", message: { role: "assistant", content: "hey" } },
        { neutralEntryId: "ns1:2", kernelEntryId: "k2", message: { role: "assistant", content: "bye" } },
      ],
    }],
  });
  // bookmarkDir 固定指向 tmp 目录(不按 cwd 拼),便于断言文件落盘。
  store = new SessionStore(noopFactory, noopCatalog, dir, undefined, neutralStore, undefined, () => bookmarkDir);
  store.setContext(CWD, SESSION_PATH);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bookmark 快照收藏", () => {
  it("物化前缀到锚点(含),写快照文件,返回自包含快照", async () => {
    const snap = await store.bookmark(SESSION_PATH, "k1", "bm-1", "收藏点", "hey");
    expect(snap.version).toBe(1);
    expect(snap.boundaryEntryId).toBe("ns1:1"); // 返回中立坐标,非内核私有 id
    expect(snap.lineage.entries.map((e) => e.neutralEntryId)).toEqual(["ns1:0", "ns1:1"]);
    // 快照文件落盘到注入的 bookmarks 目录
    const file = join(bookmarkDir, "bm-1.json");
    expect(existsSync(file)).toBe(true);
    expect(parseBookmarkSnapshot(readFileSync(file, "utf-8"))).toEqual(snap);
  });

  it("锚点不在内容里(压缩已移除):抛错,不静默卷全量", async () => {
    await expect(store.bookmark(SESSION_PATH, "k-missing", "bm-x", "x", "x")).rejects.toThrow(/锚点不在会话内容/);
  });

  it("源会话中立树不存在:抛错", async () => {
    const other = new SessionStore(noopFactory, noopCatalog, dir, undefined, new NeutralSessionStore(join(dir, "empty")), undefined, () => bookmarkDir);
    other.setContext(CWD, "/tmp/nope.jsonl");
    await expect(other.bookmark("/tmp/nope.jsonl", "k0", "bm-x", "x", "x")).rejects.toThrow(/源会话中立树不存在/);
  });
});

describe("deleteBookmark 快照删除", () => {
  it("删快照文件", async () => {
    await store.bookmark(SESSION_PATH, "k0", "bm-del", "d", "d");
    const file = join(bookmarkDir, "bm-del.json");
    expect(existsSync(file)).toBe(true);
    await store.deleteBookmark("bm-del");
    expect(existsSync(file)).toBe(false);
  });

  it("删不存在的快照:no-op 不抛", async () => {
    await expect(store.deleteBookmark("no-such")).resolves.toBeUndefined();
  });
});

describe("resume 校验路径", () => {
  it("快照不存在:抛错", async () => {
    await expect(store.resume("no-such")).rejects.toThrow(/快照不存在或已损坏/);
  });
});
