// BookmarkSnapshotStore 文件 CRUD 单测（临时目录，零 mock）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BookmarkSnapshotStore } from "./bookmark-snapshot-store";
import { BOOKMARK_SNAPSHOT_VERSION, type BookmarkSnapshot } from "@my-harness-desktop/shared";

let dir: string;
let store: BookmarkSnapshotStore;

const snap = (id: string): BookmarkSnapshot => ({
  version: BOOKMARK_SNAPSHOT_VERSION,
  id,
  label: `收藏 ${id}`,
  preview: "hi",
  createdAt: "2026-01-01T00:00:00.000Z",
  sourceKernel: "pi",
  sourceNeutralSessionId: "ns",
  boundaryEntryId: "root:1",
  lineage: {
    lineageId: `${id}-lineage`,
    entries: [
      { neutralEntryId: "root:0", message: { role: "user", content: "hi" } },
      { neutralEntryId: "root:1", message: { role: "assistant", content: "hey" } },
    ],
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bookmark-store-"));
  store = new BookmarkSnapshotStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("BookmarkSnapshotStore CRUD", () => {
  it("put → get 往返保真", () => {
    store.put(snap("a"));
    expect(store.get("a")).toEqual(snap("a"));
  });

  it("get 不存在返回 null", () => {
    expect(store.get("missing")).toBeNull();
  });

  it("delete 后 get 返回 null", () => {
    store.put(snap("a"));
    store.delete("a");
    expect(store.get("a")).toBeNull();
  });

  it("list 列全部快照,损坏文件跳过", () => {
    store.put(snap("a"));
    store.put(snap("b"));
    // 手写一个损坏文件
    writeFileSync(join(dir, "broken.json"), "{ not json", "utf-8");
    const list = store.list();
    expect(list.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("list 空目录返回空数组", () => {
    expect(store.list()).toEqual([]);
  });

  it("版本不符的快照 get 返回 null(显式降级,不抛穿)", () => {
    mkdirSync(dir, { recursive: true });
    const bad = snap("old");
    writeFileSync(join(dir, "old.json"), JSON.stringify({ ...bad, version: 99 }), "utf-8");
    expect(store.get("old")).toBeNull();
  });

  it("文件落盘到注入的 dir(项目级)", () => {
    store.put(snap("a"));
    expect(readdirSync(dir)).toContain("a.json");
  });
});
