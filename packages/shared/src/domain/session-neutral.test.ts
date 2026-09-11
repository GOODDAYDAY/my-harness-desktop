// sortLineagesTopologically 拓扑排序裸单测(§7.3):父 lineage 先于子分支,根最前;
// 环/悬空父降级不挂死。纯函数,零 mock。
import { describe, it, expect } from "vitest";
import {
  sortLineagesTopologically, resolveForkBoundaries, neutralEntryId, lineageContent,
  emptyNeutralSession, appendNeutralEntry, upsertNeutralLineage, backfillKernelEntryId, backfillUserAuthority,
  derivedHeaderFromEntry, derivedHeaderFromSession, appendNeutralEntryWithHeader,
  resolveForkBoundary, assembleSeedProjection, reprojectEntries,
  type NeutralLineage, type NeutralEntry, type NeutralSession,
} from "./session-neutral";
import { sessionMessagePreview, SESSION_PREVIEW_MAX } from "./text";

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

describe("resolveForkBoundary position 截断语义(bookmark-snapshot-fork-unify §4.4)", () => {
  // 父内容:root:0(user)、root:1(assistant)、root:2(user 待重发)
  const session: NeutralSession = {
    neutralSessionId: "root",
    header: { cwd: "/p", kernel: "pi", createdAt: "", updatedAt: "" },
    lineages: [{
      lineageId: "root",
      fork: null,
      entries: [
        { neutralEntryId: "root:0", message: { role: "user", content: "q1" } },
        { neutralEntryId: "root:1", message: { role: "assistant", content: "a1" } },
        { neutralEntryId: "root:2", message: { role: "user", content: "q2" } },
      ],
    }],
  };

  it("at(默认)含锚点:边界=锚点本身", () => {
    expect(resolveForkBoundary(session, "root", "root:2", "at")).toBe("root:2");
  });

  it("before 排除锚点:边界=锚点前一条(父前缀截到前一条,不含待重发 user)", () => {
    expect(resolveForkBoundary(session, "root", "root:2", "before")).toBe("root:1");
  });

  it("before 锚点是父内容第一条:空串(零继承前缀,从根分叉)", () => {
    expect(resolveForkBoundary(session, "root", "root:0", "before")).toBe("");
  });

  it("before 支持私有 kernelEntryId 反查", () => {
    const s2: NeutralSession = {
      ...session,
      lineages: [{
        lineageId: "root",
        fork: null,
        entries: [
          { neutralEntryId: "root:0", kernelEntryId: "k0", message: { role: "user", content: "q1" } },
          { neutralEntryId: "root:1", kernelEntryId: "k1", message: { role: "assistant", content: "a1" } },
          { neutralEntryId: "root:2", kernelEntryId: "k2", message: { role: "user", content: "q2" } },
        ],
      }],
    };
    expect(resolveForkBoundary(s2, "root", "k2", "before")).toBe("root:1");
  });

  it("before 后 lineageContent 不含锚点(不再重复待重发 user)", () => {
    const boundary = resolveForkBoundary(session, "root", "root:2", "before");
    const branched: NeutralSession = {
      ...session,
      lineages: [
        ...session.lineages,
        { lineageId: "branch", fork: { parentLineageId: "root", boundaryEntryId: boundary }, entries: [{ neutralEntryId: "branch:0", message: { role: "user", content: "q2" } }] },
      ],
    };
    const content = lineageContent(branched, "branch");
    const q2Count = content.filter((e) => e.message.content === "q2").length;
    expect(q2Count).toBe(1); // 只有重发那一条,不重复
    expect(content.map((e) => e.neutralEntryId)).toEqual(["root:0", "root:1", "branch:0"]);
  });
});

describe("neutral-first 纯函数 mutation(§neutral-session-first)", () => {
  const header = { kernel: "pi" as const, cwd: "/proj", createdAt: "2026-01-01" };
  const e = (role: string, extra?: Partial<NeutralEntry>): NeutralEntry =>
    ({ neutralEntryId: "", message: { role, content: role }, ...extra });

  it("emptyNeutralSession:空中立会话(无 lineage)", () => {
    const s = emptyNeutralSession("ns-1", header);
    expect(s.neutralSessionId).toBe("ns-1");
    expect(s.lineages).toEqual([]);
  });

  it("appendNeutralEntry:首条按根 lineage 创建,seq 从 0 起", () => {
    const s = emptyNeutralSession("ns-1", header);
    const out = appendNeutralEntry(s, "ns-1", e("user", { display: { image: { src: "~/.my-harness-desktop/s/a.png" } } }));
    expect(out.lineages).toHaveLength(1);
    expect(out.lineages[0].lineageId).toBe("ns-1");
    expect(out.lineages[0].fork).toBeNull();
    expect(out.lineages[0].entries[0].neutralEntryId).toBe("ns-1:0");
    expect(out.lineages[0].entries[0].display?.image?.src).toBe("~/.my-harness-desktop/s/a.png");
  });

  it("appendNeutralEntry:追加到已有 lineage,seq 递增", () => {
    let s = appendNeutralEntry(emptyNeutralSession("ns-1", header), "ns-1", e("user"));
    s = appendNeutralEntry(s, "ns-1", e("assistant"));
    expect(s.lineages[0].entries.map((x) => x.neutralEntryId)).toEqual(["ns-1:0", "ns-1:1"]);
  });

  it("upsertNeutralLineage:同 id 替换,不同 id 追加", () => {
    let s = emptyNeutralSession("ns-1", header);
    s = upsertNeutralLineage(s, { lineageId: "b1", fork: { parentLineageId: "ns-1", boundaryEntryId: "ns-1:0" }, entries: [] });
    s = upsertNeutralLineage(s, { lineageId: "b1", fork: { parentLineageId: "ns-1", boundaryEntryId: "ns-1:1" }, entries: [] });
    expect(s.lineages).toHaveLength(1);
    expect(s.lineages[0].fork?.boundaryEntryId).toBe("ns-1:1");
  });

  it("backfillKernelEntryId:回填最后一个 kernelEntryId 缺失的同 role entry", () => {
    let s = appendNeutralEntry(emptyNeutralSession("ns-1", header), "ns-1", e("user"));
    s = appendNeutralEntry(s, "ns-1", e("assistant"));
    s = appendNeutralEntry(s, "ns-1", e("user"));
    const out = backfillKernelEntryId(s, "ns-1", "pi-id-2", "user");
    expect(out.lineages[0].entries[0].kernelEntryId).toBeUndefined(); // 第一个 user 不动
    expect(out.lineages[0].entries[2].kernelEntryId).toBe("pi-id-2"); // 最后一个 user 回填
  });

  it("★ 已绑定条目是**边界**：不越过它去绑上一段历史里未绑的同 role 条目（fork/物化丢回复的根因）", () => {
    // 失败形态（实测，fork/seed 物化出来的会话）：
    //   · 继承来的条目是**投影**出来的，没有 kernelEntryId；
    //   · 本轮先把 user 落进中立层并绑上权威 id（已绑定 = 本回合内容的起点）；
    //   · 紧接着新一轮 assistant 的 entryAppended 到了，带着**全新**的 kernelEntryId。
    // 旧实现"一直往前找第一个未绑的同 role 条目"会穿过已绑的 user 条目，摸到**上一段历史**
    // 里那条未绑的 assistant，把新 id 绑上去 → 同一条的 messageEnd 随后判"该 id 已存在"→
    // 幂等跳过 → **这条回复在中立层里静默消失**（DOM 读中立层，用户看不到回复）。
    let s = appendNeutralEntry(emptyNeutralSession("ns-1", header), "ns-1", e("user"));        // :0 继承 user（未绑）
    s = appendNeutralEntry(s, "ns-1", e("assistant"));                                          // :1 继承 assistant（未绑）
    s = appendNeutralEntry(s, "ns-1", { neutralEntryId: "", kernelEntryId: "div-1", message: { role: "divider", content: "" } });
    s = appendNeutralEntry(s, "ns-1", { neutralEntryId: "", kernelEntryId: "this-turn-user", message: { role: "user", content: "分叉后的消息" } });

    const out = backfillKernelEntryId(s, "ns-1", "brand-new-assistant-id", "assistant");
    expect(out, "越过已绑定条目去绑旧条目 = 新回复随后被幂等跳过、静默丢失").toBe(s);
    expect(out.lineages[0].entries[1].kernelEntryId, "上一段历史的条目不该被新 id 占用").toBeUndefined();
  });

  it("尾巴上的未绑同 role 条目仍照常回填（不能因为加了边界就把正常路径也堵死）", () => {
    let s = appendNeutralEntry(emptyNeutralSession("ns-1", header), "ns-1", { neutralEntryId: "", kernelEntryId: "old-user", message: { role: "user", content: "上一条" } });
    s = appendNeutralEntry(s, "ns-1", e("assistant")); // 本回合刚 append 的、还没 id 的 assistant
    const out = backfillKernelEntryId(s, "ns-1", "fresh-assistant-id", "assistant");
    expect(out.lineages[0].entries[1].kernelEntryId).toBe("fresh-assistant-id");
  });

  it("backfillUserAuthority:回填 user 的 kernelEntryId + message.id + message.timestamp", () => {
    let s = appendNeutralEntry(emptyNeutralSession("ns-1", header), "ns-1", e("user"));
    s = appendNeutralEntry(s, "ns-1", e("assistant"));
    s = appendNeutralEntry(s, "ns-1", e("user"));
    const out = backfillUserAuthority(s, "ns-1", "pi-id-2", "msg-id-2", 1720000000000);
    const last = out.lineages[0].entries[2];
    expect(last.kernelEntryId).toBe("pi-id-2");
    expect(last.message.id).toBe("msg-id-2");
    expect(last.message.timestamp).toBe(1720000000000);
    // 前面的 entry 不动
    expect(out.lineages[0].entries[0].message.id).toBeUndefined();
  });

  it("backfillUserAuthority:权威字段缺省时不覆盖(missing 用 undefined 传)", () => {
    let s = appendNeutralEntry(emptyNeutralSession("ns-1", header), "ns-1", e("user"));
    s = appendNeutralEntry(s, "ns-1", e("user"));
    const out = backfillUserAuthority(s, "ns-1", "pi-id-2", undefined, undefined);
    expect(out.lineages[0].entries[1].kernelEntryId).toBe("pi-id-2");
    expect(out.lineages[0].entries[1].message.id).toBeUndefined();
    expect(out.lineages[0].entries[1].message.timestamp).toBeUndefined();
  });

  it("appendNeutralEntry 不 mutate 入参", () => {
    const s: NeutralSession = emptyNeutralSession("ns-1", header);
    const out = appendNeutralEntry(s, "ns-1", e("user"));
    expect(s.lineages).toEqual([]);
    expect(out.lineages).toHaveLength(1);
  });
});

describe("sessionMessagePreview 副标题预览", () => {
  it("折叠连续空白 + trim", () => {
    expect(sessionMessagePreview("  a\n\t  b ")).toBe("a b");
  });

  it("空/纯空白返回 undefined", () => {
    expect(sessionMessagePreview("")).toBeUndefined();
    expect(sessionMessagePreview("   \n\t ")).toBeUndefined();
  });

  it("超长按 SESSION_PREVIEW_MAX 截断并补 …(按 code point)", () => {
    const text = "字".repeat(SESSION_PREVIEW_MAX + 5);
    const out = sessionMessagePreview(text)!;
    expect(Array.from(out).length).toBe(SESSION_PREVIEW_MAX + 1); // 30 字 + …
    expect(out.endsWith("…")).toBe(true);
  });

  it("不超长原样返回", () => {
    expect(sessionMessagePreview("短文本")).toBe("短文本");
  });
});

describe("derivedHeaderFromEntry / derivedHeaderFromSession 列表行字段派生", () => {
  const header = { kernel: "pi" as const, cwd: "/proj", createdAt: "2026-01-01" };
  const e = (content: unknown, extra?: Partial<NeutralEntry>): NeutralEntry =>
    ({ neutralEntryId: "", message: { role: "assistant", content }, ...extra });

  it("derivedHeaderFromEntry:lastMessage 取文本预览,lastEntryId 取 entry id", () => {
    const out = derivedHeaderFromEntry({ neutralEntryId: "L:3", message: { role: "assistant", content: "hello world" } });
    expect(out.lastMessage).toBe("hello world");
    expect(out.lastEntryId).toBe("L:3");
    expect(out.updatedAt).toBeUndefined(); // 无 timestamp 且未注入 nowIso
  });

  it("derivedHeaderFromEntry:nowIso 注入时 updatedAt = nowIso", () => {
    const out = derivedHeaderFromEntry(e("hi", { neutralEntryId: "L:0" }), "2026-08-27T00:00:00.000Z");
    expect(out.updatedAt).toBe("2026-08-27T00:00:00.000Z");
  });

  it("derivedHeaderFromEntry:无 timestamp 回落 entry 时间戳", () => {
    const out = derivedHeaderFromEntry(e("hi", { neutralEntryId: "L:0", message: { role: "assistant", content: "hi", timestamp: 0 } }));
    expect(out.updatedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("derivedHeaderFromEntry:空内容 → lastMessage undefined", () => {
    const out = derivedHeaderFromEntry(e(""));
    expect(out.lastMessage).toBeUndefined();
  });

  it("derivedHeaderFromSession:取 timestamp 最新 entry(跨 lineage)", () => {
    const s: NeutralSession = {
      neutralSessionId: "ns",
      header,
      lineages: [
        { lineageId: "ns", fork: null, entries: [
          { neutralEntryId: "ns:0", message: { role: "user", content: "older", timestamp: 100 } },
        ] },
        { lineageId: "b1", fork: { parentLineageId: "ns", boundaryEntryId: "ns:0" }, entries: [
          { neutralEntryId: "b1:0", message: { role: "assistant", content: "newer", timestamp: 200 } },
        ] },
      ],
    };
    const out = derivedHeaderFromSession(s);
    expect(out.lastMessage).toBe("newer");
    expect(out.lastEntryId).toBe("b1:0");
    expect(out.updatedAt).toBe(new Date(200).toISOString());
  });

  it("derivedHeaderFromSession:无 timestamp 回落拓扑序末条 lineage 末条 entry", () => {
    const s: NeutralSession = {
      neutralSessionId: "ns",
      header,
      lineages: [
        { lineageId: "ns", fork: null, entries: [{ neutralEntryId: "ns:0", message: { role: "user", content: "a" } }] },
        { lineageId: "b1", fork: { parentLineageId: "ns", boundaryEntryId: "ns:0" }, entries: [{ neutralEntryId: "b1:0", message: { role: "assistant", content: "b" } }] },
      ],
    };
    const out = derivedHeaderFromSession(s);
    expect(out.lastMessage).toBe("b");
    expect(out.lastEntryId).toBe("b1:0");
  });

  it("derivedHeaderFromSession:空会话返回 {}", () => {
    expect(derivedHeaderFromSession(emptyNeutralSession("ns", header))).toEqual({});
  });

  it("derivedHeaderFromSession:末条无文本时 lastMessage 回落到更早有文本的 entry", () => {
    const s: NeutralSession = {
      neutralSessionId: "ns",
      header,
      lineages: [
        { lineageId: "ns", fork: null, entries: [
          { neutralEntryId: "ns:0", message: { role: "user", content: "ping", timestamp: 100 } },
          { neutralEntryId: "ns:1", message: { role: "divider", content: "", timestamp: 200 } },
        ] },
      ],
    };
    const out = derivedHeaderFromSession(s);
    expect(out.lastMessage).toBe("ping"); // 回落到有文本的 entry
    expect(out.lastEntryId).toBe("ns:1"); // 位标仍是末条
    expect(out.updatedAt).toBe(new Date(200).toISOString());
  });
});

describe("appendNeutralEntryWithHeader 追加 + 回填", () => {
  const header = { kernel: "pi" as const, cwd: "/proj", createdAt: "2026-01-01" };

  it("追加首条:根 lineage 创建 + header 回填 lastMessage/lastEntryId/updatedAt", () => {
    const s = emptyNeutralSession("ns-1", header);
    const out = appendNeutralEntryWithHeader(s, "ns-1", { neutralEntryId: "", message: { role: "user", content: "ping" } }, "2026-08-27T00:00:00.000Z");
    expect(out.lineages[0].entries[0].neutralEntryId).toBe("ns-1:0");
    expect(out.header.lastMessage).toBe("ping");
    expect(out.header.lastEntryId).toBe("ns-1:0");
    expect(out.header.updatedAt).toBe("2026-08-27T00:00:00.000Z");
  });

  it("追加第二条:seq 递增 + header 覆盖为最新 entry", () => {
    let s = appendNeutralEntryWithHeader(emptyNeutralSession("ns-1", header), "ns-1", { neutralEntryId: "", message: { role: "user", content: "ping" } }, "2026-08-27T00:00:00.000Z");
    s = appendNeutralEntryWithHeader(s, "ns-1", { neutralEntryId: "", message: { role: "assistant", content: "pong" } }, "2026-08-27T00:00:01.000Z");
    expect(s.lineages[0].entries.map((x) => x.neutralEntryId)).toEqual(["ns-1:0", "ns-1:1"]);
    expect(s.header.lastMessage).toBe("pong");
    expect(s.header.lastEntryId).toBe("ns-1:1");
    expect(s.header.updatedAt).toBe("2026-08-27T00:00:01.000Z");
  });

  it("不 mutate 入参", () => {
    const s = emptyNeutralSession("ns-1", header);
    appendNeutralEntryWithHeader(s, "ns-1", { neutralEntryId: "", message: { role: "user", content: "ping" } }, "2026-08-27T00:00:00.000Z");
    expect(s.lineages).toEqual([]);
    expect(s.header.lastMessage).toBeUndefined();
  });

  it("无文本条目(空消息/divider)不顶掉旧 lastMessage,但 lastEntryId 仍推进", () => {
    let s = appendNeutralEntryWithHeader(emptyNeutralSession("ns-1", header), "ns-1", { neutralEntryId: "", message: { role: "user", content: "ping" } }, "2026-08-27T00:00:00.000Z");
    s = appendNeutralEntryWithHeader(s, "ns-1", { neutralEntryId: "", message: { role: "divider", content: "" } }, "2026-08-27T00:00:01.000Z");
    expect(s.header.lastMessage).toBe("ping"); // 保留旧预览
    expect(s.header.lastEntryId).toBe("ns-1:1"); // 位标推进到末条
    expect(s.header.updatedAt).toBe("2026-08-27T00:00:01.000Z");
  });
});

describe("lineageContent 完整线性内容(§kernel-forkless §11)", () => {
  const e = (id: string): NeutralEntry => ({ neutralEntryId: id, message: { role: "user", content: id } });
  const header = { kernel: "pi" as const, cwd: "/p", createdAt: "t" };

  it("root:完整内容 = 自己的 entries", () => {
    const s: NeutralSession = {
      neutralSessionId: "ns",
      header,
      lineages: [{ lineageId: "ns", fork: null, entries: [e("ns:0"), e("ns:1")] }],
    };
    expect(lineageContent(s, "ns").map((x) => x.neutralEntryId)).toEqual(["ns:0", "ns:1"]);
  });

  it("分支:父前缀截到 boundary(含) + 自身 entries", () => {
    const s: NeutralSession = {
      neutralSessionId: "ns",
      header,
      lineages: [
        { lineageId: "ns", fork: null, entries: [e("ns:0"), e("ns:1"), e("ns:2")] },
        { lineageId: "b1", fork: { parentLineageId: "ns", boundaryEntryId: "ns:1" }, entries: [e("b1:0")] },
      ],
    };
    expect(lineageContent(s, "b1").map((x) => x.neutralEntryId)).toEqual(["ns:0", "ns:1", "b1:0"]);
  });

  it("多级分支:逐级截前缀", () => {
    const s: NeutralSession = {
      neutralSessionId: "ns",
      header,
      lineages: [
        { lineageId: "ns", fork: null, entries: [e("ns:0"), e("ns:1"), e("ns:2")] },
        { lineageId: "b1", fork: { parentLineageId: "ns", boundaryEntryId: "ns:1" }, entries: [e("b1:0")] },
        { lineageId: "b2", fork: { parentLineageId: "b1", boundaryEntryId: "b1:0" }, entries: [e("b2:0")] },
      ],
    };
    expect(lineageContent(s, "b2").map((x) => x.neutralEntryId)).toEqual(["ns:0", "ns:1", "b1:0", "b2:0"]);
  });

  it("悬空父引用:当根处理,不抛错", () => {
    const s: NeutralSession = {
      neutralSessionId: "ns",
      header,
      lineages: [{ lineageId: "b1", fork: { parentLineageId: "ghost", boundaryEntryId: "ghost:0" }, entries: [e("b1:0")] }],
    };
    expect(lineageContent(s, "b1").map((x) => x.neutralEntryId)).toEqual(["b1:0"]);
  });

  it("环:不无限递归", () => {
    const s: NeutralSession = {
      neutralSessionId: "ns",
      header,
      lineages: [
        { lineageId: "a", fork: { parentLineageId: "b", boundaryEntryId: "b:0" }, entries: [e("a:0")] },
        { lineageId: "b", fork: { parentLineageId: "a", boundaryEntryId: "a:0" }, entries: [e("b:0")] },
      ],
    };
    const out = lineageContent(s, "a");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("assembleSeedProjection 保留 kernelEntryId(分支种子须带内核原 id 保 fork 边界链)", () => {
  it("fork 分支的 seed 投影含父前缀的 kernelEntryId", () => {
    const session: NeutralSession = {
      neutralSessionId: "ns1",
      header: { kernel: "pi", cwd: "/tmp/x", createdAt: "2026-09-04T00:00:00.000Z" },
      lineages: [
        { lineageId: "ns1", fork: null, entries: [
          { neutralEntryId: "ns1:0", kernelEntryId: "k-user", message: { role: "user", content: "base" } },
          { neutralEntryId: "ns1:1", kernelEntryId: "k-assist", message: { role: "assistant", content: "reply" } },
        ]},
        { lineageId: "branch1", fork: { parentLineageId: "ns1", boundaryEntryId: "ns1:1" }, entries: [
          { neutralEntryId: "branch1:0", message: { role: "user", content: "branch" } },
        ]},
      ],
    };
    const proj = assembleSeedProjection(session, "branch1");
    // 父前缀(截到 boundary ns1:1 含)的 kernelEntryId 必须保留——种子用它当 pi 消息 id,
    // fork 边界(parentId)才能连回父条目的原 id,分支文件不断链。
    expect(proj.map((e) => e.kernelEntryId)).toEqual(["k-user", "k-assist", undefined]);
  });
});

describe("reprojectEntries 派生重投影(bookmark-snapshot-fork-unify §5.3)", () => {
  // 与 assembleSeedProjection 的「保留 kernelEntryId」相对:跨会话派生要换身份——
  // 中立坐标跟壳走(按新 ns 重算),内核坐标由目标内核重建(清空,不跨会话携带)。
  const source: NeutralEntry[] = [
    { neutralEntryId: "src:0", kernelEntryId: "k0", message: { role: "user", content: "q", id: "m0" }, display: { image: { src: "s.png", title: "t" } } },
    { neutralEntryId: "src:1", kernelEntryId: "k1", message: { role: "assistant", content: "a", id: "m1" } },
  ];

  it("中立 entryId 按新 ns 重算({newNs}:{seq},seq 从 0 递增)", () => {
    const out = reprojectEntries(source, "new-ns");
    expect(out.map((e) => e.neutralEntryId)).toEqual(["new-ns:0", "new-ns:1"]);
  });

  it("kernelEntryId 与 message.id 清空(目标内核重分配),内容与 display 保留", () => {
    const out = reprojectEntries(source, "new-ns");
    expect(out.every((e) => e.kernelEntryId === undefined && e.message.id === undefined)).toBe(true);
    expect(out.map((e) => e.message.content)).toEqual(["q", "a"]);
    expect(out[0].display?.image?.src).toBe("s.png"); // 展示元数据(图)随派生携带
  });

  it("不 mutate 入参(纯函数)", () => {
    const before = JSON.parse(JSON.stringify(source));
    reprojectEntries(source, "new-ns");
    expect(source).toEqual(before);
  });
});
