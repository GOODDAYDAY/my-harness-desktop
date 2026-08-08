// parseUserBlocks 单元测试 —— 结构化块机制核心纯函数。
// 机制语义:多解析器互不干扰、块按文本位置排序(与注册序无关)、main 按 start/end 区间剥离块。
import { describe, it, expect } from "vitest";
import { parseUserBlocks, type AuxBlock, type AuxBlockParser } from "./aux-blocks";

/** fixture:模拟 skill-manager 的 skill parser(去锚定,扫描式提取 + start/end)。 */
const skillParser: AuxBlockParser = {
  id: "skill",
  parse(text: string) {
    const re = /<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+?))?(?=\n<|$)/g;
    const blocks: AuxBlock[] = [];
    for (const m of text.matchAll(re)) {
      blocks.push({
        type: "skill",
        data: { name: m[1], location: m[2], content: m[3], args: m[4]?.trim() || undefined },
        start: m.index,
        end: m.index + m[0].length,
      });
    }
    return blocks.length > 0 ? { blocks } : null;
  },
};

/** fixture:模拟 review 插件的 review parser(matchAll + start/end,可多处)。 */
const reviewParser: AuxBlockParser = {
  id: "review",
  parse(text: string) {
    const re = /<pi-review>\s*([\s\S]*?)\s*<\/pi-review>/g;
    const blocks: AuxBlock[] = [];
    for (const m of text.matchAll(re)) {
      blocks.push({ type: "review", data: { inner: m[1] }, start: m.index, end: m.index + m[0].length });
    }
    return blocks.length > 0 ? { blocks } : null;
  },
};

describe("parseUserBlocks", () => {
  it("无块 → main 原样,blocks 空", () => {
    const r = parseUserBlocks("普通正文", [skillParser, reviewParser]);
    expect(r).toEqual({ main: "普通正文", blocks: [] });
  });

  it("skill 块独占消息 → main 空,skill 块(含 args)", () => {
    const text = "<skill name=\"arch\" location=\"C:\\x\">\n正文\n</skill>\n\n帮我实现";
    const r = parseUserBlocks(text, [skillParser, reviewParser]);
    expect(r.main).toBe("");
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].type).toBe("skill");
    expect(r.blocks[0].start).toBe(0);
    expect(r.blocks[0].end).toBe(text.length);
  });

  it("正文 + review 块 → main 保留正文,review 块剥离", () => {
    const r = parseUserBlocks("正文内容\n\n<pi-review>\n<item seq=\"①\">意见</item>\n</pi-review>", [skillParser, reviewParser]);
    expect(r.main).toBe("正文内容");
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].type).toBe("review");
  });

  it("skill + review 共存 → 块按文本位置排序(skill 在前,review 在后),与解析器注册序无关", () => {
    const text = "<skill name=\"arch\" location=\"L\">\n正文\n</skill>\n\n参数\n\n<pi-review>\n<item seq=\"①\">意见</item>\n</pi-review>";
    const revFirst = parseUserBlocks(text, [reviewParser, skillParser]);
    const skillFirst = parseUserBlocks(text, [skillParser, reviewParser]);
    for (const r of [revFirst, skillFirst]) {
      expect(r.blocks.map((b) => b.type)).toEqual(["skill", "review"]);
      expect(r.main).toBe("");
    }
  });

  it("多个同类型块 → 全部提取,按位置排序", () => {
    const text = "正文\n\n<pi-review>A</pi-review>\n\n<pi-review>B</pi-review>";
    const r = parseUserBlocks(text, [reviewParser]);
    expect(r.blocks.map((b) => (b.data as { inner: string }).inner)).toEqual(["A", "B"]);
    expect(r.main).toBe("正文");
  });

  it("两条内容完全相同的评论 → 各自唯一区间,剥离互不干扰(契约硬化要解决的场景)", () => {
    const dup = "<pi-review>\n<item seq=\"①\">同样的意见</item>\n</pi-review>";
    const text = `正文\n\n${dup}\n\n${dup}`;
    const r = parseUserBlocks(text, [reviewParser]);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0].start).not.toBe(r.blocks[1].start);
    expect(r.main).toBe("正文");
  });

  it("残缺标签(未闭合)不识别 → 按正文处理", () => {
    const text = "正文提到 <pi-review> 但没闭合";
    const r = parseUserBlocks(text, [skillParser, reviewParser]);
    expect(r.blocks).toHaveLength(0);
    expect(r.main).toBe(text);
  });

  it("parsers 空 → main 原样不解析", () => {
    const text = "<skill name=\"a\" location=\"b\">\nx\n</skill>";
    expect(parseUserBlocks(text, [])).toEqual({ main: text, blocks: [] });
  });
});
