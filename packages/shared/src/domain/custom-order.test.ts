// `applyCustomOrder` —— 用户拖拽出的组内自定义序（圆心纯函数，`domain/custom-order.ts`）。
//
// 为什么值得单测：它的语义**不显然**——返回的是 `[...rest, ...ordered]`，即
// **不在 order 里的项排在前面**（新会话在上、用户手动排过的在下），而不是"order 优先"。
// 这个方向读代码时很容易看反，而看反的后果是"拖完刷新顺序跳回去"这类难查的现象。
// 它是纯函数、零依赖（§4.5：不需要 mock 外部环境的就是内层材料），所以裸单测最合适。
//
// 另一层价值：e2e 侧**没法可靠驱动 framer-motion 的拖拽**（实测 CDP 的可信指针事件
// 能到达 `Reorder.Item`，但 `dragControls.start()` 之后拖拽不启动，中途 transform/zIndex
// 全是默认值）。所以"文件里的顺序 → DOM 顺序"这条读回路径由 e2e 用"预置配置文件 + 启动 +
// 断言顺序"来验，而"顺序如何被重排"的算法本身由这里的单测守住——分层覆盖，各守各的。

import { describe, it, expect } from "vitest";
import { applyCustomOrder } from "./custom-order";

interface Row { key: string; created: string }
const row = (key: string, created: string): Row => ({ key, created });
const keys = (rows: Row[]): string[] => rows.map((r) => r.key);
const getKey = (r: Row): string => r.key;
const getCreated = (r: Row): string => r.created;

describe("applyCustomOrder：组内自定义序的重建", () => {
  it("没有 order（undefined / 空数组）→ 原样返回，不重排也不排序", () => {
    const items = [row("a", "2026-01-03"), row("b", "2026-01-01"), row("c", "2026-01-02")];
    expect(applyCustomOrder(items, undefined, getKey, getCreated)).toEqual(items);
    expect(applyCustomOrder(items, [], getKey, getCreated)).toEqual(items);
  });

  it("★ 在 order 里的项排在**后面**，不在的排在**前面**（方向容易看反，这条钉住它）", () => {
    const items = [row("a", "2026-01-01"), row("b", "2026-01-02"), row("c", "2026-01-03"), row("d", "2026-01-04")];
    // b、c 被用户手动排过（顺序 c→b）；a、d 是新会话
    const out = applyCustomOrder(items, ["c", "b"], getKey, getCreated);
    expect(keys(out).slice(2), "手动排过的按 order 的次序排在后面").toEqual(["c", "b"]);
    expect(keys(out).slice(0, 2).sort(), "没排过的排在前面（新会话在上）").toEqual(["a", "d"]);
  });

  it("未排过的那部分按 created **倒序**（新在上），与列表默认序一致", () => {
    const items = [row("old", "2026-01-01"), row("mid", "2026-01-05"), row("new", "2026-01-09"), row("pinned", "2026-01-03")];
    const out = applyCustomOrder(items, ["pinned"], getKey, getCreated);
    expect(keys(out), "rest 按 created 倒序，然后才是 ordered").toEqual(["new", "mid", "old", "pinned"]);
  });

  it("order 里有**已不存在的 key**（会话被删）→ 跳过，不炸也不留空洞", () => {
    const items = [row("a", "2026-01-01"), row("b", "2026-01-02")];
    const out = applyCustomOrder(items, ["ghost", "b", "a", "another-ghost"], getKey, getCreated);
    expect(keys(out)).toEqual(["b", "a"]);
  });

  it("不丢不多：输出是输入的一个排列（集合相同、长度相同）", () => {
    const items = [row("a", "2026-01-01"), row("b", "2026-01-02"), row("c", "2026-01-03")];
    for (const order of [[], ["a"], ["c", "b", "a"], ["a", "b", "c"], ["b", "ghost", "a"]]) {
      const out = applyCustomOrder(items, order, getKey, getCreated);
      expect(out).toHaveLength(items.length);
      expect([...keys(out)].sort()).toEqual([...keys(items)].sort());
    }
  });

  it("order 里同一个 key 重复出现 → 只出现一次（按 Map 去重，不会复制行）", () => {
    const items = [row("a", "2026-01-01"), row("b", "2026-01-02")];
    const out = applyCustomOrder(items, ["a", "a", "b"], getKey, getCreated);
    expect(keys(out), "重复 key 不该让行翻倍").toEqual(["a", "b"]);
  });

  it("全部项都在 order 里 → rest 为空，输出完全等于 order 的次序", () => {
    const items = [row("a", "2026-01-01"), row("b", "2026-01-02"), row("c", "2026-01-03")];
    expect(keys(applyCustomOrder(items, ["c", "a", "b"], getKey, getCreated))).toEqual(["c", "a", "b"]);
  });

  it("created 相同（同秒创建）时 rest 内部次序稳定，不因排序抖动", () => {
    const items = [row("x", "2026-01-01"), row("y", "2026-01-01"), row("z", "2026-01-01"), row("p", "2026-01-02")];
    const out = applyCustomOrder(items, ["p"], getKey, getCreated);
    expect(keys(out)).toHaveLength(4);
    expect(keys(out)[3]).toBe("p");
    // 同 created → localeCompare 返回 0，Array.prototype.sort 在 V8 里是稳定排序，
    // 所以 rest 内部保持输入次序（这条钉住"不会随机抖动"，否则列表每次刷新顺序都可能变）
    expect(keys(out).slice(0, 3)).toEqual(["x", "y", "z"]);
  });
});
