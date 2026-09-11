// blind-review/core 的纯函数单测:覆盖组装期的截断语义。
// 为什么先测这个:该插件没有 e2e、也没有任何单测,而 core/ 是**纯函数面**(无 IO/无框架),
// 是"补覆盖"里最便宜的一处。先覆盖语义最明确、也是最容易写错边界的 `truncateContent`。
//
// 断言强度对齐被验性质:这里断的是「**前缀保留** + **是否追加标注**」,
// 不去断"整串等于某个拼接结果"——后者会把标签文案的任何改动都变成测试失败(那是文案的事,不是截断的事)。
import { describe, it, expect } from "vitest";
import { truncateContent, serializeTree, assembleTeamPrompt, assembleReports, assembleJudgePrompt, TREE_MAX_LINES, CONTENT_MAX_CHARS, type AssembleLabels } from "./assemble";
import { initRunState, markTeam, markJudge, markPhase } from "./run-state";
import { resolveConfig, squadTeams } from "./config";
import type { TeamConfig } from "./config";

const labels: AssembleLabels = {
  reportHeading: "报告:{{name}}",
  failedHeading: "失败:{{name}}",
  contentTruncated: "【内容已截断】",
  treeTruncated: "【树已截断】",
};

describe("truncateContent(组装期内容截断)", () => {
  it("恰好等于上限时不截断(边界是 <=,不是 <)", () => {
    const exact = "a".repeat(CONTENT_MAX_CHARS);
    expect(truncateContent(exact, labels)).toBe(exact);
  });

  it("超过上限时保留前 CONTENT_MAX_CHARS 个字符并追加标注", () => {
    const over = "b".repeat(CONTENT_MAX_CHARS + 10);
    const out = truncateContent(over, labels);
    expect(out.startsWith("b".repeat(CONTENT_MAX_CHARS)), "前缀未被保留").toBe(true);
    expect(out).toContain(labels.contentTruncated);
    // 且确实变短了:超出部分被丢掉(不是原样返回)
    expect(out.length).toBeLessThan(over.length);
  });

  it("未超上限时原样返回且不带标注", () => {
    const small = "hello";
    const out = truncateContent(small, labels);
    expect(out).toBe(small);
    expect(out).not.toContain(labels.contentTruncated);
  });
});

// ── run-state:状态迁移纯函数 ─────────────────────────────────────────────
// 逐条对应一个"能静默坏掉"的点:withJudge=false 的 null 哨兵、markTeam 只改目标、
// 以及纯函数的不变性(改了入参会让调用方的旧快照失效)。
describe("run-state(状态推进纯函数)", () => {
  // 用**完整**的 TeamConfig(而不是只给 id/name 的残形):残形运行时能过,但 typecheck 会红——
  // 本仓基线是 typecheck 0,测试替身也必须满足被依赖类型。
  const teams: TeamConfig[] = [
    { id: "a", name: "甲队", access: "content", enabled: true, prompt: "甲" },
    { id: "b", name: "乙队", access: "content", enabled: true, prompt: "乙" },
  ];

  it("initRunState:有裁判时裁判为 pending;无裁判时为 null(单发模式哨兵)", () => {
    expect(initRunState(teams, true).judgeStatus).toBe("pending");
    expect(initRunState(teams, false).judgeStatus).toBeNull();
    expect(initRunState(teams, true).phase).toBe("teams");
    expect(initRunState(teams, true).teams.every((t) => t.status === "pending")).toBe(true);
  });

  it("markTeam 只改目标队,其余队保持原状", () => {
    const s0 = initRunState(teams, true);
    const s1 = markTeam(s0, "b", "running");
    expect(s1.teams.find((t) => t.id === "b")!.status).toBe("running");
    expect(s1.teams.find((t) => t.id === "a")!.status, "非目标队被误改").toBe("pending");
  });

  it("markTeam 不改入参(纯函数:调用方手里的旧快照仍有效)", () => {
    const s0 = initRunState(teams, true);
    markTeam(s0, "a", "done");
    expect(s0.teams.every((t) => t.status === "pending"), "入参被就地修改").toBe(true);
  });

  it("markJudge / markPhase 只动各自字段", () => {
    const s0 = initRunState(teams, true);
    const s1 = markPhase(markJudge(s0, "done"), "judge");
    expect(s1.judgeStatus).toBe("done");
    expect(s1.phase).toBe("judge");
    expect(s1.teams.every((t) => t.status === "pending"), "推进裁判/阶段时误改了队状态").toBe(true);
  });
});

// ── config:配置解析(旧版兼容 + 兜底) ────────────────────────────────────
// 逐条对着一个"能静默坏掉"的点:非法输入回退整份默认、旧版条目补默认、
// `enabled !== false` 的微妙语义(只有显式 false 才关)、以及 squadTeams 保序。
describe("resolveConfig / squadTeams(配置解析与兜底)", () => {
  const dict = {
    teams: [
      { id: "correctness", name: "正确性", prompt: "p1" },
      { id: "security", name: "安全", prompt: "p2" },
    ],
    judgeName: "裁判",
    judgePrompt: "judge-p",
  };

  it("非法输入(空/无 prompts/空数组)回退整份默认编制", () => {
    for (const bad of [null, {}, { prompts: [] }, { prompts: "x" }]) {
      const cfg = resolveConfig(bad as Record<string, unknown> | null, dict);
      expect(cfg.prompts.length, `输入 ${JSON.stringify(bad)} 未回退默认`).toBe(4);
      expect(cfg.judge.prompt).toBe("judge-p");
    }
  });

  it("旧版条目缺 access/enabled 时补默认(content / enabled)", () => {
    const cfg = resolveConfig({ prompts: [{ id: "x", name: "X", prompt: "px" }] }, dict);
    expect(cfg.prompts[0].access).toBe("content");
    expect(cfg.prompts[0].enabled).toBe(true);
  });

  it("enabled 只有显式 false 才关(undefined/其它值都视为开)", () => {
    const cfg = resolveConfig(
      { prompts: [
        { id: "a", name: "A", prompt: "p", enabled: false },
        { id: "b", name: "B", prompt: "p" },
      ] },
      dict,
    );
    expect(cfg.prompts.find((p) => p.id === "a")!.enabled).toBe(false);
    expect(cfg.prompts.find((p) => p.id === "b")!.enabled, "缺 enabled 被误判为关").toBe(true);
  });

  it("条目不全被丢弃;全丢完则回退默认;access 只认 project", () => {
    const noisy = resolveConfig(
      { prompts: [{ id: "ok", name: "OK", prompt: "p", access: "project" }, { id: "bad" }] },
      dict,
    );
    expect(noisy.prompts.map((p) => p.id)).toEqual(["ok"]);
    expect(noisy.prompts[0].access).toBe("project");
    expect(resolveConfig({ prompts: [{ id: "bad" }] }, dict).prompts.length).toBe(4);
  });

  it("squadTeams 只留 enabled 且保持配置顺序", () => {
    const cfg = resolveConfig(
      { prompts: [
        { id: "a", name: "A", prompt: "p", enabled: false },
        { id: "b", name: "B", prompt: "p" },
        { id: "c", name: "C", prompt: "p" },
      ] },
      dict,
    );
    expect(squadTeams(cfg).map((t) => t.id)).toEqual(["b", "c"]);
  });
});

// ── serializeTree:截断标注的边界(与 truncateContent 统一) ────────────────
// 这里钉住一处**修过的**语义:标注的用途是"告诉读者有信息被丢"——没丢就不该标。
// 此前用 `lines.length >= TREE_MAX_LINES` 反推,导致**恰好** 200 个节点的**完整**树也被标"已截断"。
describe("serializeTree(树序列化与截断标注)", () => {
  const labels2: AssembleLabels = { reportHeading: "r", failedHeading: "f", contentTruncated: "CUT", treeTruncated: "TREECUT" };
  const chain = (n: number) => {
    let node: any = { name: `n${n - 1}`, isDir: false };
    for (let i = n - 2; i >= 0; i--) node = { name: `n${i}`, isDir: true, children: [node] };
    return node;
  };

  it("恰好 TREE_MAX_LINES 个节点(完整树)不标截断", () => {
    const out = serializeTree(chain(TREE_MAX_LINES), labels2);
    expect(out.includes(labels2.treeTruncated), "完整树被误标为已截断").toBe(false);
  });

  it("超过上限时标截断", () => {
    const out = serializeTree(chain(TREE_MAX_LINES + 1), labels2);
    expect(out.includes(labels2.treeTruncated)).toBe(true);
  });

  it("目录带 / 且按深度缩进两空格", () => {
    const out = serializeTree({ name: "root", isDir: true, children: [{ name: "f.ts", isDir: false }] }, labels2);
    expect(out.split("\n")).toEqual(["root/", "  f.ts"]);
  });
});

// ── 组装函数:占位替换与失败标注 ─────────────────────────────────────────
// 两个"能静默坏掉"的点:① 失败队必须用**失败标题**(注释明写"裁判需要知道覆盖缺口");
// ② `tree === null` 时**不注入**(否则 {{tree}} 会字面留在给模型的 prompt 里)。
describe("assembleTeamPrompt / assembleReports / assembleJudgePrompt", () => {
  const L: AssembleLabels = { reportHeading: "报告:{{name}}", failedHeading: "失败:{{name}}", contentTruncated: "CUT", treeTruncated: "TREECUT" };
  const team: TeamConfig = { id: "a", name: "甲队", access: "project", enabled: true, prompt: "看内容:{{content}} / 看树:{{tree}}" };
  const reports = [
    { teamId: "a", teamName: "甲队", text: "甲的意见", ok: true },
    { teamId: "b", teamName: "乙队", text: "超时", ok: false },
  ];

  it("assembleTeamPrompt:注入内容;tree 为 null 时不替换 {{tree}}(占位原样保留)", () => {
    const noTree = assembleTeamPrompt(team, "正文", null, L);
    expect(noTree).toContain("看内容:正文");
    expect(noTree, "tree 为 null 时不该注入任何树内容").toContain("{{tree}}");
    const withTree = assembleTeamPrompt(team, "正文", "root/", L);
    expect(withTree).toContain("看树:root/");
    expect(withTree).not.toContain("{{tree}}");
  });

  it("assembleReports:成功队用报告标题、失败队用**失败**标题,并替换队名", () => {
    const out = assembleReports(reports, L);
    expect(out).toContain("报告:甲队");
    expect(out, "失败队被当成功队标注").toContain("失败:乙队");
    expect(out).toContain("甲的意见");
    expect(out).toContain("超时");
  });

  it("assembleReports:多队之间用空行分隔;空列表返回空串", () => {
    expect(assembleReports(reports, L).split("\n\n").length).toBe(2);
    expect(assembleReports([], L)).toBe("");
  });

  it("assembleJudgePrompt:两个占位都替换,且内容走截断", () => {
    const judge = { name: "裁判", prompt: "C={{content}}\nR={{reports}}" };
    const out = assembleJudgePrompt(judge, "被审内容", reports, L);
    expect(out).toContain("C=被审内容");
    expect(out).toContain("报告:甲队");
    expect(out).not.toContain("{{reports}}");
  });
});
