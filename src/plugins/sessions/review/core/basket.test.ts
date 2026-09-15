// review/core/basket 纯函数单测(设计 docs/design/session-scope.md §5.1):
// 篮子迁移到会话作用域槽后,数组操作下沉为纯函数(Overlay 与 BasketBar 共用同一实现,
// 不再各写一遍)。纯函数、零依赖、不需要 mock——按 CLAUDE.md §4.5 判据是内层材料。
import { describe, it, expect } from "vitest";
import { basketAdd, basketUpdate, basketRemove, basketClear, type ReviewComment } from "./basket";

const c = (id: string, comment: string): ReviewComment =>
  ({ id, quote: `q-${id}`, comment, createdAt: 1, updatedAt: 1 });

describe("basketAdd:入篮追加到末尾", () => {
  it("追加,顺序即用户加入顺序(序号 ①②③ 按数组序派生)", () => {
    expect(basketAdd([], c("a", "第一"))).toHaveLength(1);
    const two = basketAdd([c("a", "第一")], c("b", "第二"));
    expect(two.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("不 mutate 入参(返回新数组)", () => {
    const orig = [c("a", "x")];
    const next = basketAdd(orig, c("b", "y"));
    expect(orig).toHaveLength(1);
    expect(next).not.toBe(orig);
  });
});

describe("basketUpdate:改文本,updatedAt 推进,其它条目不动", () => {
  it("只动命中的那条", () => {
    const list = [c("a", "旧"), c("b", "不动")];
    const next = basketUpdate(list, "a", "新文本", 99);
    expect(next[0].comment).toBe("新文本");
    expect(next[0].updatedAt).toBe(99);
    expect(next[1].comment).toBe("不动");
  });

  it("未命中返回同一数组引用(调用方可据此判无变化,避免无谓写)", () => {
    const list = [c("a", "x")];
    expect(basketUpdate(list, "不存在", "y", 99)).toBe(list);
  });
});

describe("basketRemove / basketClear", () => {
  it("remove 删单条,保留其余", () => {
    const next = basketRemove([c("a", "1"), c("b", "2")], "a");
    expect(next.map((x) => x.id)).toEqual(["b"]);
  });

  it("clear 返回新的空数组(不复用同一引用,避免跨会话共享)", () => {
    const empty1 = basketClear();
    const empty2 = basketClear();
    expect(empty1).toEqual([]);
    expect(empty1).not.toBe(empty2);   // 每次新数组:两个会话的篮子不共享同一实例
  });
});
