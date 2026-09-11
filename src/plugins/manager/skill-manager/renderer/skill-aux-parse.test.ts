// skill 块解析器(skill-aux.tsx 的 auxParsers[0].parse) —— **纯函数 unittest**:
// 无 DOM、无 mock、无定时器(符合 CLAUDE.md §5.6 的分工:解析器归 unittest)。
//
// 该解析器的注释里写明了三条契约,逐条钉:
//   ① **去锚定 + matchAll**:块出现在文本**任意位置**都能识别(组合场景/重试后结构变动)
//   ② **args 非贪婪 + 前瞻停在下一个块开头** —— 组合场景**不吞**下一个块(设计 §4.1)
//   ③ 无块 → 返回 **null**(而不是 {blocks: []}),这是给框架的"我没认领"信号
// 另钉:`args` 为空白时归一成 **undefined**(不是空串),以及 start/end 是**真区间**。
import { describe, it, expect } from "vitest";

import { auxParsers } from "./skill-aux";

const parse = (text: string): ReturnType<(typeof auxParsers)[number]["parse"]> =>
  auxParsers[0].parse(text);

const block = (name: string, body: string, loc = "/k/skills/" + name): string =>
  `<skill name="${name}" location="${loc}">\n${body}\n</skill>`;

describe("skill 块解析器(auxParsers[0])", () => {
  it("单个块:取出 name / location / content", () => {
    const r = parse(block("review", "# Review\n步骤一"));
    expect(r?.blocks.length).toBe(1);
    const d = r!.blocks[0].data as { name: string; location: string; content: string };
    expect(d.name).toBe("review");
    expect(d.location).toBe("/k/skills/review");
    expect(d.content).toBe("# Review\n步骤一");
    expect(r!.blocks[0].type).toBe("skill");
  });

  it("① **去锚定**:块**前面**有杂文也认得(不要求从行首开始)", () => {
    const r = parse("前置说明\n" + block("a", "B"));
    expect(r?.blocks.length).toBe(1);
    expect((r!.blocks[0].data as { name: string }).name).toBe("a");
  });

  // ⚠ 实测边界(与本文件顶部注释里"任意位置都能识别"的措辞**不符**,已记在此处供后来者):
  //   · 块后跟「**单个换行 + 杂文**」→ 解析结果 **null**(整块被忽略) —— 注释说"任意位置"不成立
  //   · 两个块以**空行**分隔 → 只认出 **1 块**(第二块被静默吞掉) —— 正是注释里说的"组合场景"
  //   两条都是我**实测**出来的(6 个用例逐个跑过),不是推断。
  //   是否构成真实缺陷取决于**发出侧**实际产出的形状 —— 该判定留给能看发出侧的人,
  //   所以此处**不断言**这两种形状(既不为通过而迎合实现,也不把未定论的边界钉成契约)。

  it("② **组合场景不吞下一个块**:两个块时,第一个块的 args 只到第二个块开头", () => {
    const text = block("a", "BODY-A") + "\n\nARGS-A\n" + block("b", "BODY-B");
    const r = parse(text);
    expect(r?.blocks.length, "组合场景没有认出两个块").toBe(2);
    const [d1, d2] = r!.blocks.map((b) => b.data as { name: string; args?: string; content: string });
    expect(d1.name).toBe("a");
    expect(d2.name, "第二个块被第一个块的 args 吞掉了").toBe("b");
    expect(d1.args, "第一个块的 args 吞多了(越过下一个块开头)").toBe("ARGS-A");
    expect(d2.content).toBe("BODY-B");
  });

  it("args 取到块后空行之后的内容;**空白 args 归一成 undefined**", () => {
    expect((parse(block("a", "B") + "\n\n真参数")!.blocks[0].data as { args?: string }).args).toBe("真参数");
    expect((parse(block("a", "B") + "\n\n   \n ")!.blocks[0].data as { args?: string }).args,
      "空白 args 应归一成 undefined(空串会让下游判空失效)").toBeUndefined();
    expect((parse(block("a", "B"))!.blocks[0].data as { args?: string }).args).toBeUndefined();
  });

  it("③ 无块 → **null**(不是空数组:那是给框架的'没认领'信号)", () => {
    expect(parse("这里没有任何 skill 块")).toBeNull();
    expect(parse("")).toBeNull();
  });

  it("start/end 是**真区间**(切片回来就是原块文本)", () => {
    const b = block("a", "B");
    const text = "前" + b;
    const blk = parse(text)!.blocks[0];
    expect(text.slice(blk.start, blk.end)).toBe(b);
  });

  it("多个块时 start **逐个**指向各自的标签(不是都指第一块)", () => {
    const b1 = block("a", "B1"), b2 = block("b", "B2");
    const text = b1 + "\n\nARGS1\n" + b2;
    const blks = parse(text)!.blocks;
    expect(blks.length).toBe(2);
    expect(text.slice(blks[0].start, blks[0].start + 6), "第一块的 start 没指向 <skill").toBe("<skill");
    expect(text.slice(blks[1].start, blks[1].start + 6), "第二块的 start 指错了").toBe("<skill");
    expect(blks[0].start).toBe(0);
    // 实测语义:end **包含 args**(args 属同一个 match),故第一块的 end 落在第二块标签之前
    expect(blks[0].end, "第一块的 end 越过了第二块").toBeLessThanOrEqual(blks[1].start);
  });
});
