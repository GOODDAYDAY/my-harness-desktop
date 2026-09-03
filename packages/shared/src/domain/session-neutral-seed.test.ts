// assembleSeedProjection 单测:seed 投影组装的纯函数行为。
// 业务语义对齐 session-single-source §4.1:压缩截断(摘要代身) + role 白名单。
import { describe, it, expect } from "vitest";
import { assembleSeedProjection, emptyNeutralSession, appendNeutralEntry, type NeutralSession, type NeutralEntry } from "./session-neutral";
import type { NeutralMessage } from "./events/session-state";

function msg(role: string, text: string): NeutralMessage {
  return { role, content: text } as NeutralMessage;
}

function entry(lineageId: string, seq: number, m: NeutralMessage): NeutralEntry {
  return { neutralEntryId: `${lineageId}:${seq}`, message: m };
}

function compactionDivider(seq: number, detail?: string): NeutralEntry {
  return {
    neutralEntryId: `root:${seq}`,
    message: { role: "divider", kind: "compaction", content: "", detail } as unknown as NeutralMessage,
  };
}

function sessionOf(entries: NeutralEntry[]): NeutralSession {
  return { neutralSessionId: "ns", header: { kernel: "pi", cwd: "/p", createdAt: "t" }, lineages: [{ lineageId: "root", fork: null, entries }] };
}

describe("assembleSeedProjection", () => {
  it("role 白名单:只留 user/assistant/toolResult,divider 与 custom 条目不进投影", () => {
    const s = sessionOf([
      entry("root", 0, msg("user", "问")),
      entry("root", 1, msg("assistant", "答")),
      { neutralEntryId: "root:2", message: { role: "divider", kind: "model", content: "" } as unknown as NeutralMessage },
      { neutralEntryId: "root:3", message: { role: "goal-card", content: "插件卡片" } as unknown as NeutralMessage },
      entry("root", 4, msg("toolResult", "工具结果")),
    ]);
    const out = assembleSeedProjection(s, "root");
    expect(out.map((e) => e.message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(out.map((e) => e.message.content)).toEqual(["问", "答", "工具结果"]);
  });

  it("无压缩边界:全量投影", () => {
    const s = sessionOf([entry("root", 0, msg("user", "a")), entry("root", 1, msg("assistant", "b"))]);
    expect(assembleSeedProjection(s, "root")).toHaveLength(2);
  });

  it("带摘要的压缩边界:摘要代身 + 边界之后条目,边界之前丢弃", () => {
    const s = sessionOf([
      entry("root", 0, msg("user", "旧问")),
      entry("root", 1, msg("assistant", "旧答")),
      compactionDivider(2, "摘要:聊过天气"),
      entry("root", 3, msg("user", "新问")),
      entry("root", 4, msg("assistant", "新答")),
    ]);
    const out = assembleSeedProjection(s, "root");
    expect(out).toHaveLength(3);
    expect(out[0].message.role).toBe("user");
    expect(String(out[0].message.content)).toContain("摘要:聊过天气");
    expect(String(out[0].message.content)).toContain("压缩摘要");
    expect(out.slice(1).map((e) => e.message.content)).toEqual(["新问", "新答"]);
  });

  it("压缩边界无摘要:退回全量投影(保守,不丢上下文)", () => {
    const s = sessionOf([
      entry("root", 0, msg("user", "旧问")),
      compactionDivider(1, undefined),
      entry("root", 2, msg("user", "新问")),
    ]);
    const out = assembleSeedProjection(s, "root");
    expect(out.map((e) => e.message.content)).toEqual(["旧问", "新问"]);
  });

  it("多个压缩边界:只认最新一条带摘要的", () => {
    const s = sessionOf([
      entry("root", 0, msg("user", "最早")),
      compactionDivider(1, "旧摘要"),
      entry("root", 2, msg("user", "中间")),
      compactionDivider(3, "新摘要"),
      entry("root", 4, msg("user", "最新")),
    ]);
    const out = assembleSeedProjection(s, "root");
    expect(out).toHaveLength(2);
    expect(String(out[0].message.content)).toContain("新摘要");
    expect(out[1].message.content).toBe("最新");
  });

  it("分支 lineage:投影含父前缀,且压缩截断作用于拼好的完整线性内容", () => {
    const base = emptyNeutralSession("ns", { kernel: "pi", cwd: "/p", createdAt: "t" });
    let s = appendNeutralEntry(base, "root", entry("root", 0, msg("user", "根问")));
    s = appendNeutralEntry(s, "root", entry("root", 1, msg("assistant", "根答")));
    s = { ...s, lineages: [...s.lineages, { lineageId: "br", fork: { parentLineageId: "root", boundaryEntryId: "root:0" }, entries: [entry("br", 0, msg("user", "分支问"))] }] };
    const out = assembleSeedProjection(s, "br");
    // 父前缀截到 boundary(root:0 含),再拼分支独有
    expect(out.map((e) => e.message.content)).toEqual(["根问", "分支问"]);
  });
});
