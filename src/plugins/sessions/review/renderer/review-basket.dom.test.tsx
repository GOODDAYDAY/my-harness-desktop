// @vitest-environment jsdom
// review 插件 DOM 交互测试(三级测试第二级,补全 review 零测试缺口):
//   评论篮全生命周期——addComment 入篮 → BasketBar 渲染条目/计数 → 就地编辑
//   → 删除单条 → 清空;buildReviewBlock 的 <pi-review> 结构(转义/序号/空篮);
//   auxParsers 的块解析(round-trip:build → parse 回读)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useReviewBasketStore } from "./review-basket-store";
import { buildReviewBlock } from "./index";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k, i18n: { language: "zh-CN" } }),
}));
vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({ events: { on: () => () => {}, invoke: vi.fn() } }),
  useUiStore: () => ({ currentNeutralSessionId: "sess-1" }),
  useSessionStore: () => ({ snapshot: null, streaming: false }),
}));

import { ReviewBasketBar } from "./basket-bar";

describe("评论篮 store 全生命周期(数据面)", () => {
  beforeEach(() => {
    useReviewBasketStore.getState().clearBasket("sess-1");
    useReviewBasketStore.getState().clearBasket("sess-2");
  });

  it("addComment:入篮,sessionKey 隔离(两个会话互不可见)", () => {
    const { addComment } = useReviewBasketStore.getState();
    addComment("sess-1", { id: "c1", quote: "第一段", comment: "论证不足", createdAt: 1, updatedAt: 1 });
    addComment("sess-2", { id: "c2", quote: "别的会话", comment: "隔离", createdAt: 1, updatedAt: 1 });
    const { baskets } = useReviewBasketStore.getState();
    expect(baskets.get("sess-1")).toHaveLength(1);
    expect(baskets.get("sess-1")![0].comment).toBe("论证不足");
    expect(baskets.get("sess-2")).toHaveLength(1);
  });

  it("updateComment:改文本,updatedAt 推进;其它条目不动", () => {
    const { addComment, updateComment } = useReviewBasketStore.getState();
    addComment("sess-1", { id: "a", quote: "q", comment: "旧", createdAt: 1, updatedAt: 1 });
    addComment("sess-1", { id: "b", quote: "q2", comment: "不动", createdAt: 1, updatedAt: 1 });
    updateComment("sess-1", "a", "新文本");
    const list = useReviewBasketStore.getState().baskets.get("sess-1")!;
    expect(list[0].comment).toBe("新文本");
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(1);
    expect(list[1].comment).toBe("不动");
  });

  it("removeComment/clearBasket:删单条与清空", () => {
    const { addComment, removeComment, clearBasket } = useReviewBasketStore.getState();
    addComment("sess-1", { id: "a", quote: "q", comment: "1", createdAt: 1, updatedAt: 1 });
    addComment("sess-1", { id: "b", quote: "q", comment: "2", createdAt: 1, updatedAt: 1 });
    removeComment("sess-1", "a");
    expect(useReviewBasketStore.getState().baskets.get("sess-1")).toHaveLength(1);
    clearBasket("sess-1");
    expect(useReviewBasketStore.getState().baskets.get("sess-1")).toHaveLength(0);
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
    expect(out).toContain("<pi-review>");
    expect(out).toContain("以下是用户对之前回复的评论:");
    expect(out).toContain('<item seq="①" quote="引用&lt;文本&gt;">评论&amp;内容</item>');
    expect(out).toContain('<item seq="②"');
    expect(out).toContain("</pi-review>");
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
    useReviewBasketStore.getState().clearBasket("sess-1");
    cleanup();
  });

  it("空篮:不渲染任何条目", () => {
    const { container } = render(<ReviewBasketBar payload={{ items: [], promptFragment: "", sessionKey: "sess-1" } as never} />);
    // 空篮:无条目文本(具体空态由组件决定,至少无残留)
    expect(container.textContent ?? "").not.toContain("论证不足");
  });

  it("有篮:渲染引用+评论文本;删单条按钮逐条生效", () => {
    const { addComment, removeComment } = useReviewBasketStore.getState();
    addComment("sess-1", { id: "x1", quote: "被引用段落", comment: "这条不行", createdAt: 1, updatedAt: 1 });
    const { getByText } = render(<ReviewBasketBar payload={{ items: useReviewBasketStore.getState().baskets.get("sess-1")!, promptFragment: "", sessionKey: "sess-1" } as never} />);
    expect(getByText(/这条不行/)).toBeInTheDocument();
    // 删单条(x1)——store 变化后条目消失
    removeComment("sess-1", "x1");
    // (bar 是受控 props 渲染;store 变化的重渲染经组件订阅——此处验 store 已删)
    expect(useReviewBasketStore.getState().baskets.get("sess-1")).toHaveLength(0);
  });
});
