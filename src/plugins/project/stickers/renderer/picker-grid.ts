// 表情包选择器网格导航 —— 纯函数,可裸单测(设计 docs/design/sticker-plugin.md §5)。
// 方向键语义:←→ 水平 ±1(平铺回绕);↑↓ 垂直 ±列数(列保持回绕:
// 越顶回该列末行、越底回该列首行)——不再是"↓=右移一格"的平铺语义。

/** 网格方向键移动。cols<1 按 1 列兜底;count<=0 恒回 0。 */
export function moveIndex(index: number, key: string, cols: number, count: number): number {
  if (count <= 0) return 0;
  const c = Math.max(1, Math.floor(cols));
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "ArrowDown") {
    // 下一行同列;越底(或下一行缺该列)回该列首行——首行恒满,index % c 必有效。
    return index + c < count ? index + c : index % c;
  }
  if (key === "ArrowUp") {
    if (index - c >= 0) return index - c;
    // 越顶回该列末行;末行可能缺该列,向上找最近存在该列的行。
    const col = index % c;
    let row = Math.ceil(count / c) - 1;
    while (row > 0 && row * c + col >= count) row--;
    return row * c + col;
  }
  return index;
}

/** 解析网格实际列数。浏览器里读 computed grid tracks(准,随弹层实际宽度/项数变化);
 *  读不出真实轨道(jsdom/未布局:值为空或含 repeat)时按弹层宽度公式推:
 *  弹层 maxWidth = min(420, 视口宽-16),内边距 p-2 = 8×2,格 72 + 间距 gap-2 = 8。 */
export function resolveGridCols(grid: HTMLElement | null, viewportWidth: number): number {
  const tracks = grid ? getComputedStyle(grid).gridTemplateColumns : "";
  if (tracks && !tracks.includes("repeat")) {
    const n = tracks.split(" ").filter(Boolean).length;
    if (n > 0) return n;
  }
  const inner = Math.min(420, viewportWidth - 16) - 16;
  return Math.max(1, Math.floor((inner + 8) / 80));
}
