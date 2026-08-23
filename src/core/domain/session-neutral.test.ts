// sortLineagesTopologically 拓扑排序裸单测(§7.3):父 lineage 先于子分支,根最前;
// 环/悬空父降级不挂死。纯函数,零 mock。
import { describe, it, expect } from "vitest";
import { sortLineagesTopologically, resolveForkBoundaries, neutralEntryId, type NeutralLineage, type NeutralEntry } from "./session-neutral";

const entry = (id: string): NeutralEntry => ({ neutralEntryId: id, message: { role: "user", content: "hi" } });

function lineage(id: string, parent?: { parentLineageId: string; boundaryEntryId: string }): NeutralLineage {
  return { lineageId: id, fork: parent ?? null, entries: [entry(id)] };
}

describe("sortLineagesTopologically 拓扑排序", () => {
  it("根在前,分支在后(根→分支→分支的分支)", () => {
    const root = lineage("root");
    const b1 = lineage("b1", { parentLineageId: "root", boundaryEntryId: "root:0" });
    const b2 = lineage("b2", { parentLineageId: "b1", boundaryEntryId: "b1:0" });
    const out = sortLineagesTopologically([b2, b1, root]); // 乱序输入
    expect(out.map((l) => l.lineageId)).toEqual(["root", "b1", "b2"]);
  });

  it("分支先于父的乱序输入:排序后父在前", () => {
    const root = lineage("root");
    const b1 = lineage("b1", { parentLineageId: "root", boundaryEntryId: "root:0" });
    const out = sortLineagesTopologically([b1, root]);
    expect(out.map((l) => l.lineageId)).toEqual(["root", "b1"]);
  });

  it("有环(损坏数据):不无限递归,不丢节点", () => {
    const a = lineage("a", { parentLineageId: "b", boundaryEntryId: "b:0" });
    const b = lineage("b", { parentLineageId: "a", boundaryEntryId: "a:0" });
    const out = sortLineagesTopologically([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.lineageId).sort()).toEqual(["a", "b"]);
  });

  it("parentLineageId 悬空:按根处理,不抛错", () => {
    const orphan = lineage("orphan", { parentLineageId: "missing", boundaryEntryId: "x" });
    const out = sortLineagesTopologically([orphan]);
    expect(out).toHaveLength(1);
    expect(out[0].lineageId).toBe("orphan");
  });

  it("空数组返回空数组", () => {
    expect(sortLineagesTopologically([])).toEqual([]);
  });
});

describe("neutralEntryId", () => {
  it("{lineageId}:{seq}", () => {
    expect(neutralEntryId("L1", 0)).toBe("L1:0");
    expect(neutralEntryId("L1", 3)).toBe("L1:3");
  });
});

describe("resolveForkBoundaries 边界归一", () => {
  const root: NeutralLineage = {
    lineageId: "root",
    fork: null,
    entries: [
      { neutralEntryId: "root:0", kernelEntryId: "r0", message: { role: "user", content: "hi" } },
      { neutralEntryId: "root:1", kernelEntryId: "r1", message: { role: "assistant", content: "ok" } },
    ],
  };
  const child: NeutralLineage = {
    lineageId: "child",
    fork: { parentLineageId: "root", boundaryEntryId: "r1" }, // 私有 boundary = r1
    entries: [{ neutralEntryId: "child:0", kernelEntryId: "c0", message: { role: "user", content: "forked" } }],
  };

  it("私有 boundary 反查成父 lineage 的中立 id", () => {
    const out = resolveForkBoundaries([root, child]);
    expect(out[1].fork?.boundaryEntryId).toBe("root:1");
  });

  it("反查不到(dsh 坐标系不同/损坏)→ 空串降级", () => {
    const bad: NeutralLineage = {
      ...child,
      fork: { parentLineageId: "root", boundaryEntryId: "不存在的私有 id" },
    };
    const out = resolveForkBoundaries([root, bad]);
    expect(out[1].fork?.boundaryEntryId).toBe("");
  });

  it("不 mutate 入参", () => {
    const before = JSON.parse(JSON.stringify(child));
    resolveForkBoundaries([root, child]);
    expect(child.fork?.boundaryEntryId).toBe(before.fork.boundaryEntryId); // 入参未被改
  });
});
