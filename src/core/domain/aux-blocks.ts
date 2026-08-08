// 圆心:结构化块机制 —— domain/aux-blocks,零依赖。
//
// 用户消息 content 里会混入"机器可识别、对用户是噪声"的结构化块
// (底座展开的 <skill> 块、插件附加的 <pi-review> 块等)。本文件提供
// 识别机制(纯函数),不感知任何具体块的形状——具体块类型的解析器由
// 插件贡献(renderer 侧注册表),新块类型 = 新插件,内核零改动。
// 依据 docs/design/aux-block-mechanism.md。

/** 解析出的结构化块:内核只认 type + 泛型 data,不感知具体块的形状。 */
export interface AuxBlock {
  /** 块类型("skill" | "review" | 未来任意)。 */
  type: string;
  /** 块载荷,形状由贡献方定义。 */
  data: unknown;
  /** 块在原文中的起止位置(start inclusive, end exclusive)——由 parser 精确给出。 */
  start: number;
  end: number;
}

/** 块解析器契约:基于原文扫描,提取所有本类型完整块;无匹配返回 null。
 *  解析器互不干扰(各扫各的类型),由 parseUserBlocks 汇总排序。 */
export interface AuxBlockParser {
  /** 解析器 id(注册去重/覆盖用)。 */
  id: string;
  parse(text: string): { blocks: AuxBlock[] } | null;
}

/** 汇总所有解析器结果:按块 start 排序(文本顺序保真),
 *  按 [start, end) 区间切片剥离全部块得 main(压缩连续空行再 trim)。
 *  组合场景(skill 块 + review 块共存)天然正确,与解析器注册顺序无关;
 *  两条内容完全相同的块各有唯一区间,切片互不干扰(契约硬化,不再猜边界)。 */
export function parseUserBlocks(text: string, parsers: AuxBlockParser[]): { main: string; blocks: AuxBlock[] } {
  if (!text || parsers.length === 0) return { main: text, blocks: [] };
  const found: { block: AuxBlock; pos: number }[] = [];
  for (const p of parsers) {
    const r = p.parse(text);
    if (!r) continue;
    for (const b of r.blocks) found.push({ block: b, pos: b.start });
  }
  found.sort((a, b) => a.pos - b.pos);
  const blocks = found.map((f) => f.block);
  if (blocks.length === 0) return { main: text, blocks: [] };
  // 按 [start, end) 区间切掉块,区间不重叠(同一文本位置只被一个 parser 认领)
  let cursor = 0;
  let main = "";
  for (const b of blocks) {
    main += text.slice(cursor, b.start);
    cursor = b.end;
  }
  main += text.slice(cursor);
  return { main: main.replace(/\n{3,}/g, "\n\n").trim(), blocks };
}
