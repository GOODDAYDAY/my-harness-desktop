// projectLineageTree 单测:入口级树 → lineage 树投影。
// 依据 docs/design/base-interface-lineage.md §2.3(节点从「条目」换成「分叉点」)。
import { describe, it, expect } from "vitest";
import type { TreeNode } from "./events/session-state";
import { projectLineageTree } from "./backend";

/** 造 TreeNode 的简写。 */
function node(entryId: string, children?: TreeNode[]): TreeNode {
  return { entryId, children };
}

describe("projectLineageTree", () => {
  it("空树返回空 lineage 树", () => {
    expect(projectLineageTree([])).toEqual({ rootId: "", lineages: [] });
  });

  it("单链(无分叉)只有根一条 lineage", () => {
    const tree = node("r", [node("a", [node("b")])]);
    expect(projectLineageTree([tree])).toEqual({
      rootId: "r",
      lineages: [{ id: "r", fork: null }],
    });
  });

  it("根处分叉:首子续主干,其余子各开一条分支 lineage", () => {
    const tree = node("r", [node("a"), node("b"), node("c")]);
    expect(projectLineageTree([tree])).toEqual({
      rootId: "r",
      lineages: [
        { id: "r", fork: null },
        { id: "b", fork: { parentLineageId: "r", boundary: "r" } },
        { id: "c", fork: { parentLineageId: "r", boundary: "r" } },
      ],
    });
  });

  it("中段分叉:分支 lineage 的 boundary 是分叉点 entryId,parent 是所在 lineage", () => {
    // r → a → (b, c);b → d。主干=r(含 r,a,b,d),分支=c(从 a 分叉)。
    const tree = node("r", [node("a", [node("b", [node("d")]), node("c")])]);
    expect(projectLineageTree([tree])).toEqual({
      rootId: "r",
      lineages: [
        { id: "r", fork: null },
        { id: "c", fork: { parentLineageId: "r", boundary: "a" } },
      ],
    });
  });

  it("分支可再分叉:分支 lineage 成为下一层分叉的 parent", () => {
    // r → (a, b);b → (c, d)。主干=r→a;分支 b(从 r);b 下再分 c(续 b 主干)、d(从 b 分叉)。
    const tree = node("r", [node("a"), node("b", [node("c"), node("d")])]);
    expect(projectLineageTree([tree])).toEqual({
      rootId: "r",
      lineages: [
        { id: "r", fork: null },
        { id: "b", fork: { parentLineageId: "r", boundary: "r" } },
        { id: "d", fork: { parentLineageId: "b", boundary: "b" } },
      ],
    });
  });

  it("森林:第一个根是 rootId,其余根各作独立根 lineage", () => {
    expect(projectLineageTree([node("r1"), node("r2")])).toEqual({
      rootId: "r1",
      lineages: [
        { id: "r1", fork: null },
        { id: "r2", fork: null },
      ],
    });
  });
});
