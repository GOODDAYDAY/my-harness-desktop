// @vitest-environment jsdom
// review 插件 DOM 交互测试(三级测试第二级):
//   评论篮全生命周期——入篮 → BasketBar 渲染条目 → 就地编辑 → 删单条 → 清空;
//   buildReviewBlock 的 <review> 结构(转义/序号/空篮);auxParsers round-trip;标签中性化与历史标签兼容;
//   **篮子按会话隔离**(迁移到会话作用域槽后的核心目的,设计 docs/design/session-scope.md §3.3.1)。
//
// mock 边界:只 mock usePluginContext(IPC 边界)与 react-i18next。useUiStore/useSessionStore/
// 会话作用域 hook 全部真跑——mock 掉作用域就测不出「A 的评论不出现在 B」这个迁移目的。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { buildReviewBlock, sessionSlots } from "./index";
import type { ReviewComment } from "../core/basket";

// i18n:给真字典(断言跑真文案,不断言 key —— CLAUDE.md §5.6)。
// 字典值取自 locales/zh-CN/shell.json,改文案时测试跟文案一起改。
vi.mock("react-i18next", () => {
  const dict: Record<string, string> = { "shell.clearAll": "清空全部" };
  return {
    useTranslation: () => ({
      t: (k: string, opts?: { defaultValue?: string }) => dict[k] ?? opts?.defaultValue ?? k,
      i18n: { language: "zh-CN" },
    }),
  };
});
vi.mock("@my-harness-desktop/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@my-harness-desktop/react")>();
  return {
    ...actual,   // 作用域 hook / useUiStore / useSessionStore 全部真跑
    usePluginContext: () => ({ events: { on: () => () => {}, invoke: vi.fn() } }),
  };
});

import { ReviewBasketBar } from "./basket-bar";
import { useUiStore, ensureSlotsRegistered, pluginWrapper } from "@my-harness-desktop/react";
import { __resetScopesForTests, useSessionScopeStore } from "@my-harness-desktop/react";
import type { SessionSlot } from "@my-harness-desktop/shared";

const REVIEW_PLUGIN_ID = "review";
ensureSlotsRegistered(REVIEW_PLUGIN_ID, sessionSlots as SessionSlot[]);
const ReviewWrapper = pluginWrapper(REVIEW_PLUGIN_ID);

const c = (id: string, comment: string): ReviewComment =>
  ({ id, quote: `引用-${id}`, comment, createdAt: 1, updatedAt: 1 });

const BASKET_SLOT = "review:basket";
/** 直接往某会话的篮子槽写(绕过 UI 构造前置态)。经**真实**作用域容器,不是假 store。 */
function seedBasket(scopeKey: string, list: ReviewComment[]): void {
  useSessionScopeStore.getState().write(BASKET_SLOT, scopeKey, list);
}
function readBasket(scopeKey: string): ReviewComment[] {
  return useSessionScopeStore.getState().read<ReviewComment[]>(BASKET_SLOT, scopeKey);
}

function activate(ns: string): void {
  useUiStore.setState({ currentNeutralSessionId: ns, currentSessionPath: `/p/${ns}.jsonl`, currentCwd: "/p" });
}

describe("评论篮按会话隔离(会话作用域槽,设计 §3.3.1)", () => {
  beforeEach(() => {
    __resetScopesForTests();
    activate("sess-1");
    cleanup();
  });

  it("两个会话的篮子互不可见(此前插件自己用 Map<sessionKey,…> 分组,现在容器承担)", () => {
    seedBasket("sess-1", [c("a", "会话一的评论")]);
    seedBasket("sess-2", [c("b", "会话二的评论")]);
    expect(readBasket("sess-1").map((x) => x.comment)).toEqual(["会话一的评论"]);
    expect(readBasket("sess-2").map((x) => x.comment)).toEqual(["会话二的评论"]);
  });

  it("物化搬迁 carry:concat 把壳期评论追加到真身已有评论之后(旧实现手写 17 行迁移的语义)", () => {
    seedBasket("new:/p", [c("shell", "壳期加的")]);
    seedBasket("ns-real", [c("real", "真身已有的")]);
    useSessionScopeStore.getState().carry("new:/p", "ns-real");
    // concat:目标已有值在前,搬来的在后(与旧实现的 [...(next.get(ns) ?? []), ...draft] 同语义)
    expect(readBasket("ns-real").map((x) => x.id)).toEqual(["real", "shell"]);
    // 壳键域整体摘除
    expect(useSessionScopeStore.getState().scopes.has("new:/p")).toBe(false);
  });
});

describe("buildReviewBlock(篮 → sendSuffix 结构文本)", () => {
  it("结构头 + 序号条目 + 引用/评论(转义)", () => {
    const out = buildReviewBlock(
      [
        { id: "1", quote: "引用<文本>", comment: "评论&内容", createdAt: 1, updatedAt: 1 },
        { id: "2", quote: "第二段", comment: "补充", createdAt: 1, updatedAt: 1 },
      ],
      "以下是用户对之前回复的评论:",
    );
    expect(out).toContain("<review>");
    expect(out).toContain("以下是用户对之前回复的评论:");
    expect(out).toContain('<item seq="①" quote="引用&lt;文本&gt;">评论&amp;内容</item>');
    expect(out).toContain('<item seq="②"');
    expect(out).toContain("</review>");
  });

  it("空篮返回空串(无可附加)", () => {
    expect(buildReviewBlock([], "头")).toBe("");
  });

  it("round-trip:build 出的块能被 auxParsers 解析回结构数据(渲染层解析一致性)", async () => {
    const { auxParsers } = await import("./index");
    const parser = auxParsers.find((p) => p.id === "review")!;
    const text = "前置文本\n" + buildReviewBlock(
      [
        { id: "1", quote: "引用段", comment: "第一条评论", createdAt: 1, updatedAt: 1 },
        { id: "2", quote: "第二段", comment: "第二条", createdAt: 1, updatedAt: 1 },
      ],
      "以下是用户对之前回复的评论:",
    ) + "\n后置文本";
    const parsed = parser.parse(text);
    expect(parsed?.blocks).toHaveLength(1);
    const data = parsed!.blocks[0].data as { count: number; items: { seq: string; comment: string; quote?: string }[] };
    expect(data.count).toBe(2);
    expect(data.items[0].comment).toBe("第一条评论");
    expect(data.items[0].quote).toBe("引用段");
    expect(data.items[1].seq).toBe("②");
  });
});

describe("ReviewBasketBar DOM(渲染面)", () => {
  beforeEach(() => {
    __resetScopesForTests();
    activate("sess-1");
    cleanup();
  });

  const payloadFor = (list: ReviewComment[]) => ({
    items: list.map((x, i) => ({ id: x.id, seq: String(i + 1), messageId: x.messageId, quotePreview: x.quote, comment: x.comment })),
    promptFragment: "",
    sessionKey: "sess-1",
  }) as never;

  it("空篮:不渲染任何条目(组件在 items 为空时返回 null)", () => {
    const { container } = render(<ReviewBasketBar payload={payloadFor([])} />, { wrapper: ReviewWrapper });
    expect(container.firstChild).toBeNull();
  });

  it("有篮:渲染引用 + 评论文本", () => {
    render(<ReviewBasketBar payload={payloadFor([c("x1", "这条不行")])} />, { wrapper: ReviewWrapper });
    expect(screen.getByText(/这条不行/)).toBeInTheDocument();
    expect(screen.getByText(/引用-x1/)).toBeInTheDocument();
  });

  it("删单条:点 ✕ 按 payload.sessionKey 从作用域槽移除(不是从当前激活域)", () => {
    seedBasket("sess-1", [c("x1", "要删的"), c("x2", "留下的")]);
    render(<ReviewBasketBar payload={payloadFor(readBasket("sess-1"))} />, { wrapper: ReviewWrapper });
    screen.getAllByText("✕")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(readBasket("sess-1").map((x) => x.id)).toEqual(["x2"]);
  });

  it("清空:点「清空」按 payload.sessionKey 清对应会话的篮子", () => {
    seedBasket("sess-1", [c("x1", "a"), c("x2", "b")]);
    seedBasket("sess-2", [c("y1", "别动我")]);
    render(<ReviewBasketBar payload={payloadFor(readBasket("sess-1"))} />, { wrapper: ReviewWrapper });
    screen.getByText("清空全部").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(readBasket("sess-1")).toEqual([]);
    // 关键:清的是 payload 指定的 sess-1,不是「当前激活会话」——用户可能已切走
    expect(readBasket("sess-2").map((x) => x.id)).toEqual(["y1"]);
  });
});

// ---- 标签中性化 + 历史标签兼容（r27）----
//
// 为什么改名：`sessions/review` 是**通用**壳插件，评论篮对任何内核都适用，而块文本是
// **拼进 prompt 发给当前内核**的。旧标签 `<pi-review>` 让 dsh / minimal 会话的 prompt 里
// 也出现一个以 pi 命名的标签——内核身份泄漏（CLAUDE.md §1.4 无特权差异）。
// 为什么必须兼容：标签随 prompt **落进了会话文件**，历史消息里全是 `<pi-review>`；
// 解析方若只认新标签，老会话的评论块会退化成裸文本显示（用户看到的是"评论变成了一串 XML"）。
describe("review 块标签：中性化 + 历史兼容", () => {
  const HEADER = "以下是用户对之前回复的评论:";
  const COMMENTS = [{ id: "1", quote: "引用段", comment: "第一条评论", createdAt: 1, updatedAt: 1 }];

  it("写方产出**中性**标签，且标签名里不含任何内核名", async () => {
    const out = buildReviewBlock(COMMENTS, HEADER);
    expect(out.startsWith("<review>")).toBe(true);
    expect(out.endsWith("</review>")).toBe(true);
    // 这条是防回潮的判据本身：块文本会进 prompt，所以标签名不能带内核身份
    for (const kernel of ["pi", "dsh", "minimal"]) {
      expect(out.toLowerCase(), `块文本里出现了内核名 "${kernel}"`).not.toContain(kernel);
    }
  });

  /** 解析器契约返回 `{ blocks } | null`（不是裸数组）——统一在这里收口。 */
  async function parseBlocks(text: string) {
    const { auxParsers } = await import("./index");
    const parser = auxParsers.find((p) => p.id === "review")!;
    return parser.parse(text)?.blocks ?? [];
  }

  it("解析方**同时**认新标签与历史 `<pi-review>`（老会话不退化成裸文本）", async () => {
    const legacy = `<pi-review>\n${HEADER}\n<item seq="①" quote="引用段">第一条评论</item>\n</pi-review>`;
    const modern = buildReviewBlock(COMMENTS, HEADER);
    for (const [label, text] of [["历史标签", legacy], ["新标签", modern]] as const) {
      const blocks = await parseBlocks(`前置\n${text}\n后置`);
      expect(blocks.length, `${label}应被解析成一个块`).toBe(1);
      const data = blocks[0].data as { count: number; items: { comment: string; quote?: string }[] };
      expect(data.count, `${label}的条目数`).toBe(1);
      expect(data.items[0].comment).toBe("第一条评论");
      expect(data.items[0].quote).toBe("引用段");
      // start/end 必须精确指向块本身（渲染层靠它切正文，不能把前后文本吞进去）
      const sliced = `前置\n${text}\n后置`.slice(blocks[0].start, blocks[0].end);
      expect(sliced, `${label}的 start/end 应恰好覆盖整块`).toBe(text);
    }
  });

  it("开闭标签**错配**不匹配（`<review>…</pi-review>` 按正文处理，不吞掉后续内容）", async () => {
    const mismatched = '<review>\n头\n<item seq="①">评论</item>\n</pi-review>';
    expect(await parseBlocks(mismatched), "错配标签必须不被当成块（反向引用 \\1 的作用）").toEqual([]);
  });

  it("同一文本里新旧标签混存也能各自解析（历史会话被续写后可能出现）", async () => {
    const legacy = '<pi-review>\n头\n<item seq="①" quote="旧引用">旧评论</item>\n</pi-review>';
    const modern = buildReviewBlock(COMMENTS, HEADER);
    const blocks = await parseBlocks(`${legacy}\n中间正文\n${modern}`);
    expect(blocks.length, "两个块都要被解析出来").toBe(2);
    const comments = blocks.map((b) => (b.data as { items: { comment: string }[] }).items[0].comment);
    expect(comments).toEqual(["旧评论", "第一条评论"]);
    // 区间不重叠（aux-block 机制的不变量：两个 parser/两个块不能覆盖同一段文本）
    expect(blocks[0].end).toBeLessThanOrEqual(blocks[1].start!);
  });
});
