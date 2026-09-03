// cloneNeutralSession + resolveBoundaryEntryId 单测(session-single-source §4.2/§4.3)。
import { describe, it, expect } from "vitest";
import { cloneNeutralSession, resolveBoundaryEntryId, emptyNeutralSession, appendNeutralEntry, type NeutralEntry, type NeutralSession } from "./session-neutral";

const header = { kernel: "pi" as const, cwd: "/p", createdAt: "t0", name: "源会话" };

function entry(lid: string, seq: number, text: string, kernelEntryId?: string): NeutralEntry {
  return { neutralEntryId: `${lid}:${seq}`, kernelEntryId, message: { role: "user", content: text } };
}

function treeWithBranch(): NeutralSession {
  let s = emptyNeutralSession("ns", header);
  s = appendNeutralEntry(s, "ns", entry("ns", 0, "根1", "k0"));
  s = appendNeutralEntry(s, "ns", entry("ns", 1, "根2", "k1"));
  s = { ...s, lineages: [...s.lineages, { lineageId: "br", fork: { parentLineageId: "ns", boundaryEntryId: "ns:0" }, entries: [entry("br", 0, "支1", "k2")] }] };
  return s;
}

describe("cloneNeutralSession", () => {
  it("整树复制:根取新 ns,分支派生确定性 id,条目重派生且清内核 id", () => {
    const cloned = cloneNeutralSession(treeWithBranch(), "ns2", { nowIso: "t1" });
    expect(cloned.neutralSessionId).toBe("ns2");
    expect(cloned.lineages).toHaveLength(2);
    const root = cloned.lineages.find((l) => l.fork === null)!;
    const branch = cloned.lineages.find((l) => l.fork !== null)!;
    expect(root.lineageId).toBe("ns2");
    expect(branch.lineageId).toBe("ns2-fork-0");
    // 分支 fork 引用换绑到新根,boundary 换绑到新根的同 seq
    expect(branch.fork!.parentLineageId).toBe("ns2");
    expect(branch.fork!.boundaryEntryId).toBe("ns2:0");
    // 条目内容保留,内核身份字段清除
    expect(root.entries.map((e) => e.message.content)).toEqual(["根1", "根2"]);
    expect(root.entries[0].neutralEntryId).toBe("ns2:0");
    expect(root.entries[0].kernelEntryId).toBeUndefined();
    expect(root.entries[0].message.id).toBeUndefined();
    // 头域:name/createdAt 更新,其余保留
    expect(cloned.header.createdAt).toBe("t1");
  });

  it("克隆结果的线性投影与源一致(lineageContent 对克隆树成立)", () => {
    const src = treeWithBranch();
    const cloned = cloneNeutralSession(src, "ns2", { nowIso: "t1" });
    const branchContent = cloned.lineages.find((l) => l.fork !== null)!;
    // 分支内容 = 父前缀截到 boundary(ns2:0 含) + 分支独有
    const prefix = branchContent.fork!.boundaryEntryId;
    expect(prefix).toBe("ns2:0");
  });
});

describe("resolveBoundaryEntryId", () => {
  it("中立 id 原样命中", () => {
    expect(resolveBoundaryEntryId(treeWithBranch(), "ns", "ns:1")).toBe("ns:1");
  });
  it("内核条目 id 翻译为中立 id(老调用方传 kernelEntryId)", () => {
    expect(resolveBoundaryEntryId(treeWithBranch(), "ns", "k1")).toBe("ns:1");
  });
  it("解析不出则原样透传(投影对未知边界是安全兜底,不丢调用方信息)", () => {
    expect(resolveBoundaryEntryId(treeWithBranch(), "ns", "stale-id")).toBe("stale-id");
  });
  it("父 lineage 不存在:原样透传", () => {
    expect(resolveBoundaryEntryId(treeWithBranch(), "no-such", "ns:1")).toBe("ns:1");
  });
});
