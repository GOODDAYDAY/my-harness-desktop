// applyNeutralChange 单测:中立层变更通知的镜像归约(session-single-source §3.2)。
import { describe, it, expect } from "vitest";
import { applyNeutralChange, emptyNeutralSession, type NeutralChange, type NeutralEntry, type NeutralSession } from "./session-neutral";

const header = { kernel: "pi" as const, cwd: "/p", createdAt: "t0" };
const ns = "ns";

function entry(lid: string, seq: number, text: string, kernelEntryId?: string): NeutralEntry {
  return { neutralEntryId: `${lid}:${seq}`, kernelEntryId, message: { role: "assistant", content: text } };
}

function entryChange(ns: string, lid: string, e: NeutralEntry, h = header): NeutralChange {
  return { ns, kind: "entry", lineageId: lid, entry: e, header: h };
}

describe("applyNeutralChange", () => {
  it("entry:无该条目则 append(按中立 entryId)", () => {
    const s = emptyNeutralSession("ns", header);
    const next = applyNeutralChange(s, entryChange("ns", "root", entry("root", 0, "答")));
    expect(next.lineages).toHaveLength(1);
    expect(next.lineages[0].entries).toHaveLength(1);
    expect(next.lineages[0].entries[0].message.content).toBe("答");
  });

  it("entry:同中立 entryId 幂等替换(回填场景,不双写)", () => {
    let s = emptyNeutralSession("ns", header);
    s = applyNeutralChange(s, entryChange("ns", "root", entry("root", 0, "答")));
    // 回填权威 id 的回执:同 neutralEntryId,补上 kernelEntryId
    const bound = entry("root", 0, "答", "k-1");
    const next = applyNeutralChange(s, entryChange("ns", "root", bound));
    expect(next.lineages[0].entries).toHaveLength(1);
    expect(next.lineages[0].entries[0].kernelEntryId).toBe("k-1");
  });

  it("entry:写后 header 随回执覆盖镜像头(append 派生字段同步新鲜)", () => {
    const s = emptyNeutralSession("ns", header);
    const h2 = { ...header, lastMessage: "答", lastEntryId: "root:0" };
    const next = applyNeutralChange(s, entryChange("ns", "root", entry("root", 0, "答"), h2));
    expect(next.header.lastMessage).toBe("答");
  });

  it("header:浅合并头域(改名/归档)", () => {
    let s = emptyNeutralSession("ns", header);
    s = applyNeutralChange(s, entryChange("ns", "root", entry("root", 0, "答")));
    const next = applyNeutralChange(s, { ns, kind: "header", header: { ...header, name: "新名", pinned: true } });
    expect(next.header.name).toBe("新名");
    expect(next.header.pinned).toBe(true);
    expect(next.lineages[0].entries).toHaveLength(1); // 内容不动
  });

  it("lineage:fork 插新分支整枝 upsert", () => {
    let s = emptyNeutralSession("ns", header);
    s = applyNeutralChange(s, entryChange("ns", "root", entry("root", 0, "根")));
    const branch = { lineageId: "br", fork: { parentLineageId: "root", boundaryEntryId: "root:0" }, entries: [] as NeutralEntry[] };
    const next = applyNeutralChange(s, { ns, kind: "lineage", lineage: branch, header });
    expect(next.lineages).toHaveLength(2);
    expect(next.lineages[1].fork?.parentLineageId).toBe("root");
  });

  it("session:全量替换(快照重建/书签发起)", () => {
    let s = emptyNeutralSession("ns", header);
    s = applyNeutralChange(s, entryChange("ns", "root", entry("root", 0, "旧")));
    const fresh: NeutralSession = { neutralSessionId: "ns", header: { ...header, name: "全新" }, lineages: [] };
    const next = applyNeutralChange(s, { ns, kind: "session", session: fresh });
    expect(next).toBe(fresh);
  });

  it("不可变性:归约不 mutate 入参", () => {
    const s = emptyNeutralSession("ns", header);
    const before = JSON.stringify(s);
    applyNeutralChange(s, entryChange("ns", "root", entry("root", 0, "答")));
    expect(JSON.stringify(s)).toBe(before);
  });
});
