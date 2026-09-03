// neutralSessionToTree 守卫测试(§209:get_tree → 中立层读;树面板/快照共用投影)。
// 钉死:① 线性链嵌套 ② fork 挂 boundary 双 child ③ entryType 词表映射 ④ preview 派生
//      ⑤ boundary 悬空降级挂根不丢分支 ⑥ isLeaf 标记 ⑦ 空会话空树。
import { describe, expect, it } from "vitest";
import { neutralSessionToTree, neutralEntryId, type NeutralSession } from "./session-neutral";

function mkSession(lineages: NeutralSession["lineages"]): NeutralSession {
  return {
    neutralSessionId: "ns-1",
    header: { kernel: "pi", cwd: "/p", createdAt: "2026-01-01T00:00:00.000Z" },
    lineages,
  };
}
function entry(lineageId: string, seq: number, role: string, text = "", extra: Record<string, unknown> = {}): NeutralSession["lineages"][number]["entries"][number] {
  return {
    neutralEntryId: neutralEntryId(lineageId, seq),
    message: { role, content: text, timestamp: 1000 + seq, ...extra },
  };
}

describe("neutralSessionToTree(中立层 → 逐条明细树投影)", () => {
  it("单 lineage:线性链嵌套(后一条是前一条的 child)", () => {
    const s = mkSession([{ lineageId: "L", fork: null, entries: [
      entry("L", 0, "user", "你好"),
      entry("L", 1, "assistant", "你好!有什么可以帮你?"),
    ] }]);
    const tree = neutralSessionToTree(s);
    expect(tree).toHaveLength(1);
    expect(tree[0].entryType).toBe("user");
    expect(tree[0].preview).toBe("你好");
    expect(tree[0].isLeaf).toBe(false);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children![0].entryType).toBe("assistant");
    expect(tree[0].children![0].isLeaf).toBe(true);
  });

  it("fork lineage:链头挂父 boundary 节点为额外 child(分叉双 child)", () => {
    const s = mkSession([
      { lineageId: "root", fork: null, entries: [entry("root", 0, "user", "a"), entry("root", 1, "assistant", "b"), entry("root", 2, "user", "主线继续")] },
      { lineageId: "br", fork: { parentLineageId: "root", boundaryEntryId: neutralEntryId("root", 1) }, entries: [entry("br", 0, "user", "分支问题")] },
    ]);
    const tree = neutralSessionToTree(s);
    const boundary = tree[0].children![0]; // root:1
    expect(boundary.children).toHaveLength(2); // 主线后续(root:2) + 分支链头(br:0)
    expect(boundary.children![0].preview).toBe("主线继续");
    expect(boundary.children![1].preview).toBe("分支问题");
  });

  it("entryType 词表:divider kind 映射(model→model_change 等),消息按 role", () => {
    const s = mkSession([{ lineageId: "L", fork: null, entries: [
      entry("L", 0, "divider", "", { kind: "model", i18nArgs: { provider: "p1", modelId: "m1" } }),
      entry("L", 1, "divider", "", { kind: "info", i18nArgs: { name: "会话名" } }),
      entry("L", 2, "user", "hi"),
      entry("L", 3, "assistant", "hello"),
      entry("L", 4, "toolResult", "", {}),
    ] }]);
    const types: string[] = [];
    const walk = (ns: { children?: typeof ns }[]): void => { for (const n of ns) { types.push((n as { entryType?: string }).entryType ?? ""); walk(n.children ?? []); } };
    walk(tree1(s));
    function tree1(x: NeutralSession) { return neutralSessionToTree(x); }
    expect(types).toEqual(["model_change", "session_info", "user", "assistant", "toolResult"]);
  });

  it("preview:model 分隔线取 provider · modelId;rename 取新名;空文本不伪造", () => {
    const s = mkSession([{ lineageId: "L", fork: null, entries: [
      entry("L", 0, "divider", "", { kind: "model", i18nArgs: { provider: "apps-studio", modelId: "qwen3.8-max" } }),
      entry("L", 1, "divider", "", { kind: "info", i18nArgs: { name: "ping" } }),
    ] }]);
    const tree = neutralSessionToTree(s);
    expect(tree[0].preview).toBe("apps-studio · qwen3.8-max");
    expect(tree[0].children![0].preview).toBe("ping");
  });

  it("boundary 悬空(损坏数据):分支降级挂森林根,不丢", () => {
    const s = mkSession([
      { lineageId: "root", fork: null, entries: [entry("root", 0, "user", "a")] },
      { lineageId: "br", fork: { parentLineageId: "root", boundaryEntryId: "root:99" }, entries: [entry("br", 0, "user", "孤儿分支")] },
    ]);
    const tree = neutralSessionToTree(s);
    expect(tree).toHaveLength(2);
    expect(tree[1].preview).toBe("孤儿分支");
  });

  it("空会话/空 lineage:空树", () => {
    expect(neutralSessionToTree(mkSession([]))).toEqual([]);
    expect(neutralSessionToTree(mkSession([{ lineageId: "L", fork: null, entries: [] }]))).toEqual([]);
  });

  it("entryId = 中立 entryId(树点击 scrollTo 与镜像消息 id 同坐标)", () => {
    const s = mkSession([{ lineageId: "L", fork: null, entries: [entry("L", 0, "user", "x")] }]);
    expect(neutralSessionToTree(s)[0].entryId).toBe("L:0");
  });
});
