// picker-grid 纯函数单测 —— 方向键移动语义(←→ 水平回绕,↑↓ 垂直列保持回绕)
// 与列数解析(jsdom/无布局环境走宽度公式兜底)。
import { describe, it, expect } from "vitest";
import { moveIndex, resolveGridCols } from "./picker-grid";

describe("moveIndex", () => {
  // 7 项 × 5 列:行0 = 0-4(满),行1 = 5-6(缺列 2/3/4)
  it("←→ 水平平移,平铺回绕", () => {
    expect(moveIndex(0, "ArrowRight", 5, 7)).toBe(1);
    expect(moveIndex(6, "ArrowRight", 5, 7)).toBe(0);
    expect(moveIndex(0, "ArrowLeft", 5, 7)).toBe(6);
    expect(moveIndex(3, "ArrowLeft", 5, 7)).toBe(2);
  });

  it("↓ 垂直下移一行(+列数),不是右移一格", () => {
    expect(moveIndex(0, "ArrowDown", 5, 7)).toBe(5);
    expect(moveIndex(1, "ArrowDown", 5, 7)).toBe(6);
  });

  it("↓ 越底回该列首行;下一行缺该列也回首行", () => {
    expect(moveIndex(5, "ArrowDown", 5, 7)).toBe(0); // 底行 → 首行同列
    expect(moveIndex(2, "ArrowDown", 5, 7)).toBe(2); // 下一行缺列 2 → 停首行同列(=自身)
  });

  it("↑ 垂直上移一行;越顶回该列末行", () => {
    expect(moveIndex(5, "ArrowUp", 5, 7)).toBe(0);
    expect(moveIndex(1, "ArrowUp", 5, 7)).toBe(6); // 列 1 末行 = 6
  });

  it("↑ 越顶而末行缺该列:回最近存在该列的行", () => {
    expect(moveIndex(2, "ArrowUp", 5, 7)).toBe(2); // 行1 缺列 2 → 停自身
    expect(moveIndex(4, "ArrowUp", 5, 12)).toBe(9); // 12 项 × 5 列:列 4 末行是行1(9),行2 只有 10/11
  });

  it("单行网格:↑↓ 原地不动", () => {
    expect(moveIndex(1, "ArrowDown", 5, 3)).toBe(1);
    expect(moveIndex(1, "ArrowUp", 5, 3)).toBe(1);
  });

  it("兜底:cols<1 按 1 列,count<=0 回 0", () => {
    expect(moveIndex(0, "ArrowDown", 0, 4)).toBe(1);
    expect(moveIndex(0, "ArrowDown", 5, 0)).toBe(0);
    expect(moveIndex(2, "KeyA", 5, 7)).toBe(2);
  });
});

describe("resolveGridCols", () => {
  it("无 DOM(jsdom/未布局)按弹层宽度公式推", () => {
    // 视口 1024:min(420,1008)=420,内 404,(404+8)/80 → 5 列
    expect(resolveGridCols(null, 1024)).toBe(5);
    // 窄视口 300:min(420,284)=284,内 268 → 3 列
    expect(resolveGridCols(null, 300)).toBe(3);
    // 极窄也保底 1 列
    expect(resolveGridCols(null, 40)).toBe(1);
  });
});
