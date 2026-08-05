// tree-model 单测:compressedRows 的脊柱/分支/铁轨延续语义(git-graph 泳道模型)。
import { describe, it, expect } from "vitest";
import type { TreeNode } from "@pi-desktop/react";
import { compressedRows, visibleForest } from "./tree-model";

const N = (
  entryId: string,
  entryType: string,
  timestamp: number,
  children: TreeNode[] = [],
): TreeNode => ({ entryId, entryType, timestamp, children, isLeaf: children.length === 0 });

const ALL = () => true;

describe("compressedRows 泳道拍平", () => {
  // root→a1 分叉:b1(旧旁支)与 b2(含叶子);c1 是当前叶子
  const tree = (): TreeNode[] => [
    N("root", "user", 1, [
      N("a1", "assistant", 2, [
        N("b1", "user", 3),
        N("b2", "user", 4, [N("c1", "assistant", 5)]),
      ]),
    ]),
  ];

  it("脊柱孩子同深度延续,旁支 depth+1 且先走(分支块紧贴分叉点)", () => {
    const rows = compressedRows(visibleForest(tree(), ALL), ALL, "c1");
    expect(rows.map((r) => r.node.entryId)).toEqual(["root", "a1", "b1", "b2", "c1"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 0, 0]);
  });

  it("forkKids=旁支数(可见子节点-1)", () => {
    const rows = compressedRows(visibleForest(tree(), ALL), ALL, "c1");
    expect(rows.map((r) => r.forkKids)).toEqual([0, 1, 0, 0, 0]);
  });

  it("cont 铁轨延续:主干贯穿旁支块,旁支轨在块尾终止", () => {
    const rows = compressedRows(visibleForest(tree(), ALL), ALL, "c1");
    expect(rows[0].cont).toEqual([true]);        // root:主干向下延续
    expect(rows[1].cont).toEqual([true]);        // a1:主干延续
    expect(rows[2].cont).toEqual([true, false]); // b1:主干穿过,旁支轨到此为止
    expect(rows[3].cont).toEqual([true]);        // b2:主干延续
    expect(rows[4].cont).toEqual([false]);       // c1:全线结束
  });

  it("无线性缩进:无分叉长链全部 depth 0", () => {
    const chain = (): TreeNode[] => [N("1", "user", 1, [N("2", "assistant", 2, [N("3", "user", 3, [N("4", "assistant", 4)])])])];
    const rows = compressedRows(visibleForest(chain(), ALL), ALL, "4");
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 0, 0]);
    expect(rows.every((r) => r.forkKids === 0)).toBe(true);
  });

  it("无 leafId 时脊柱取子树最新者", () => {
    const rows = compressedRows(visibleForest(tree(), ALL), ALL, null);
    // b2 子树(ts 5)比 b1(ts 3)新 → b2 为脊柱,与含叶子情形同序
    expect(rows.map((r) => r.node.entryId)).toEqual(["root", "a1", "b1", "b2", "c1"]);
  });

  it("collapsed 的分叉点保留徽章但不递归子树", () => {
    const rows = compressedRows(visibleForest(tree(), ALL), ALL, "c1", undefined, new Set(["a1"]));
    expect(rows.map((r) => r.node.entryId)).toEqual(["root", "a1"]);
    expect(rows[1].forkKids).toBe(1);
    expect(rows[1].hasKids).toBe(true);
  });
});
