// materializeLineagePrefix + 快照往返 纯函数单测（零 mock）。
// 依据 docs/design/bookmark-snapshot-fork-unify.md §2/§3。
import { describe, it, expect } from "vitest";
import {
  materializeLineagePrefix,
  serializeBookmarkSnapshot,
  parseBookmarkSnapshot,
  BOOKMARK_SNAPSHOT_VERSION,
  type BookmarkSnapshot,
} from "./bookmark-snapshot";
import { neutralEntryId, type NeutralEntry, type NeutralLineage, type NeutralSession } from "./session-neutral";

const entry = (lineageId: string, seq: number): NeutralEntry => ({
  neutralEntryId: neutralEntryId(lineageId, seq),
  message: { role: seq % 2 === 0 ? "user" : "assistant", content: `m${seq}` },
});

function session(lineages: NeutralLineage[]): NeutralSession {
  return { neutralSessionId: "ns", header: { kernel: "pi", cwd: "/p", createdAt: "now" }, lineages };
}

describe("materializeLineagePrefix 物化前缀", () => {
  it("根 lineage：截到锚点（含），锚点之后的条目丢弃", () => {
    const root: NeutralLineage = {
      lineageId: "root",
      fork: null,
      entries: [entry("root", 0), entry("root", 1), entry("root", 2), entry("root", 3)],
    };
    const prefix = materializeLineagePrefix(session([root]), "root", "root:1");
    expect(prefix).not.toBeNull();
    expect(prefix!.map((e) => e.neutralEntryId)).toEqual(["root:0", "root:1"]);
  });

  it("锚点在末条：物化完整内容", () => {
    const root: NeutralLineage = { lineageId: "root", fork: null, entries: [entry("root", 0), entry("root", 1)] };
    const prefix = materializeLineagePrefix(session([root]), "root", "root:1");
    expect(prefix!.map((e) => e.neutralEntryId)).toEqual(["root:0", "root:1"]);
  });

  it("锚点不在内容里（压缩已移除）：返回 null，不静默卷全量", () => {
    const root: NeutralLineage = { lineageId: "root", fork: null, entries: [entry("root", 0), entry("root", 1)] };
    expect(materializeLineagePrefix(session([root]), "root", "root:99")).toBeNull();
  });

  it("分支 lineage：沿 fork 链物化父前缀 + 自身独有条目到锚点", () => {
    const root: NeutralLineage = { lineageId: "root", fork: null, entries: [entry("root", 0), entry("root", 1)] };
    const b1: NeutralLineage = {
      lineageId: "b1",
      fork: { parentLineageId: "root", boundaryEntryId: "root:0" },
      entries: [entry("b1", 0), entry("b1", 1)],
    };
    // b1 完整内容 = [root:0, b1:0, b1:1]（父前缀截到 root:0，再拼 b1 自己）
    const prefix = materializeLineagePrefix(session([root, b1]), "b1", "b1:0");
    expect(prefix!.map((e) => e.neutralEntryId)).toEqual(["root:0", "b1:0"]);
  });

  it("lineageId 悬空：lineageContent 当根处理 → 内容空 → 锚点找不到 → null", () => {
    const s = session([]);
    expect(materializeLineagePrefix(s, "missing", "x")).toBeNull();
  });
});

describe("快照序列化往返", () => {
  const snap: BookmarkSnapshot = {
    version: BOOKMARK_SNAPSHOT_VERSION,
    id: "id-1",
    label: "收藏点",
    preview: "hi",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceKernel: "pi",
    sourceNeutralSessionId: "ns",
    boundaryEntryId: "root:1",
    lineage: { lineageId: "snap-lineage", entries: [entry("root", 0), entry("root", 1)] },
  };

  it("往返保真：entries / boundary / 元数据一致", () => {
    const parsed = parseBookmarkSnapshot(serializeBookmarkSnapshot(snap));
    expect(parsed).toEqual(snap);
  });

  it("版本不符：显式抛错", () => {
    const bad = serializeBookmarkSnapshot(snap).replace(/"version": 1/, '"version": 99');
    expect(() => parseBookmarkSnapshot(bad)).toThrow(/版本不兼容/);
  });

  it("结构损坏（缺 lineage.entries）：显式抛错", () => {
    const bad = JSON.stringify({ version: BOOKMARK_SNAPSHOT_VERSION, id: "x" });
    expect(() => parseBookmarkSnapshot(bad)).toThrow(/结构损坏/);
  });
});
