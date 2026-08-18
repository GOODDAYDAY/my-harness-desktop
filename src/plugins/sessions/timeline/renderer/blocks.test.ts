// blocks + 槽解析的运行时验证(docs/design/timeline-block-renderers.md §6)。
// 分解器行为保全:五个 role 分支 + bashExecution/未知 role 归一 + display:false 不渲染;
// 解析规则:特化层 > 通用层、层内 order 小者胜、同 order 注册序后者胜。
import { describe, it, expect } from "vitest";
import { decomposeMessage } from "./blocks";
import { resolveBlockRenderer, type BlockRendererItem } from "@my-harness-desktop/react";
import type { NeutralMessage, AuxBlock } from "@my-harness-desktop/contract";

const msg = (extra: Record<string, unknown>): NeutralMessage => ({ content: "", ...extra }) as NeutralMessage;

describe("decomposeMessage", () => {
  it("user → userText 块,工具限制前缀剥除", () => {
    const noted = "[System] 本次会话已限制可用工具。\n可用工具: bash\n请勿使用未在列表中的工具。\n\n你好";
    const blocks = decomposeMessage(msg({ role: "user", content: noted }));
    expect(blocks).toEqual([{ type: "userText", text: "你好" }]);
  });

  it("assistant → thinking → toolCall → text 分组装,组内保原序", () => {
    const blocks = decomposeMessage(msg({
      role: "assistant",
      content: [
        { type: "toolCall", id: "t1", name: "bash", args: { command: "ls" } },
        { type: "thinking", thinking: "想想" },
        { type: "text", text: "结论" },
      ],
    }));
    expect(blocks?.map((b) => b.type)).toEqual(["thinking", "toolCall", "text"]);
  });

  it("assistant 空内容 → 空数组(空消息提示是行 chrome,不在分解器)", () => {
    expect(decomposeMessage(msg({ role: "assistant", content: "" }))).toEqual([]);
  });

  it("divider → 块字段直取,缺省 i18nKey/kind 有兜底", () => {
    const blocks = decomposeMessage(msg({ role: "divider" }));
    expect(blocks).toEqual([{ type: "divider", kind: "info", i18nKey: "timeline.divider", i18nArgs: undefined, detail: undefined, tone: undefined }]);
  });

  it("bashExecution → 合成 bash toolCall 块(exitCode 非零即 isError)", () => {
    const blocks = decomposeMessage(msg({ role: "bashExecution", command: "ls", output: "out", exitCode: 1 }));
    expect(blocks).toEqual([{
      type: "toolCall",
      toolCall: { name: "bash", args: { command: "ls", cwd: undefined }, result: "out", isError: true },
    }]);
  });

  it("未知 role → 合成 toolCall 兜底块(name 取 role)", () => {
    const blocks = decomposeMessage(msg({ role: "customThing", content: "x" }));
    expect(blocks?.[0]).toMatchObject({ type: "toolCall", toolCall: { name: "customThing" } });
  });

  it("toolResult 孤儿(折叠未配对)→ 合成只有结果的工具卡:name 取 toolName,id 留 toolCallId,不 dump 整条消息", () => {
    const blocks = decomposeMessage(msg({
      role: "toolResult", toolCallId: "ghost:9", toolName: "bash",
      content: [{ type: "text", text: "out" }], isError: true,
    }));
    expect(blocks).toEqual([{
      type: "toolCall",
      toolCall: {
        id: "ghost:9", name: "bash", args: undefined,
        result: [{ type: "text", text: "out" }], isError: true,
      },
    }]);
  });

  it("未知 role 且 display===false → null(显式隐藏)", () => {
    expect(decomposeMessage(msg({ role: "customThing", display: false }))).toBeNull();
  });

  it("user + skill 块(底座格式,独占开头)→ userIntent 气泡 + auxBlock 块(含 args)", () => {
    const text = "<skill name=\"arch\" location=\"L\">\n正文\n</skill>\n\n帮我实现";
    const blocks = decomposeMessage(msg({ role: "user", content: text }), [skillParser]);
    expect(blocks).toEqual([
      { type: "userIntent" },
      { type: "auxBlock", aux: { type: "skill", data: { name: "arch", location: "L", content: "正文", args: "帮我实现" }, start: 0, end: text.length } },
    ]);
  });

  it("正文 + skill 块(去锚定)→ userText 正文 + auxBlock 块", () => {
    const text = "先写正文\n\n<skill name=\"arch\" location=\"L\">\n正文\n</skill>\n\n参数";
    const blocks = decomposeMessage(msg({ role: "user", content: text }), [skillParser]);
    expect(blocks).toEqual([
      { type: "userText", text: "先写正文" },
      { type: "auxBlock", aux: { type: "skill", data: { name: "arch", location: "L", content: "正文", args: "参数" }, start: text.indexOf("<skill"), end: text.length } },
    ]);
  });

  it("user 正文 + review 块 → userText 正文 + auxBlock 块", () => {
    const blockText = "<pi-review>\n<item seq=\"①\">意见</item>\n</pi-review>";
    const text = `正文内容\n\n${blockText}`;
    const blocks = decomposeMessage(msg({ role: "user", content: text }), [reviewParser]);
    expect(blocks).toEqual([
      { type: "userText", text: "正文内容" },
      { type: "auxBlock", aux: { type: "review", data: { inner: "<item seq=\"①\">意见</item>" }, start: text.length - blockText.length, end: text.length } },
    ]);
  });

  it("纯评论(正文留空)→ userIntent 气泡 + auxBlock 块,无 userText", () => {
    const blockText = "<pi-review>\n<item seq=\"①\">意见</item>\n</pi-review>";
    const text = blockText;
    const blocks = decomposeMessage(msg({ role: "user", content: text }), [reviewParser]);
    expect(blocks).toEqual([
      { type: "userIntent" },
      { type: "auxBlock", aux: { type: "review", data: { inner: "<item seq=\"①\">意见</item>" }, start: 0, end: text.length } },
    ]);
  });
});

const skillParser = {
  id: "skill",
  parse(text: string) {
    const re = /<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+?))?(?=\n<|$)/g;
    const blocks: AuxBlock[] = [];
    for (const m of text.matchAll(re)) {
      blocks.push({
        type: "skill",
        data: { name: m[1], location: m[2], content: m[3], args: m[4]?.trim() },
        start: m.index,
        end: m.index + m[0].length,
      });
    }
    return blocks.length > 0 ? { blocks } : null;
  },
} as const;

const reviewParser = {
  id: "review",
  parse(text: string) {
    const re = /<pi-review>\s*([\s\S]*?)\s*<\/pi-review>/g;
    const blocks: AuxBlock[] = [];
    for (const m of text.matchAll(re)) {
      blocks.push({ type: "review", data: { inner: m[1] }, start: m.index, end: m.index + m[0].length });
    }
    return blocks.length > 0 ? { blocks } : null;
  },
} as const;

const item = (extra: Partial<BlockRendererItem>): BlockRendererItem => ({
  id: "x", block: "toolCall", component: "C", pluginId: "p", ...extra,
});

describe("resolveBlockRenderer", () => {
  it("特化层(names 精确命中,大小写不敏感)优先于通用层", () => {
    const items = [item({ id: "generic", names: undefined }), item({ id: "bash", names: ["Bash"] })];
    expect(resolveBlockRenderer(items, "toolCall", "bash")?.id).toBe("bash");
  });

  it("通用层兜底:无 names 的贡献接住未认领工具名", () => {
    const items = [item({ id: "generic" })];
    expect(resolveBlockRenderer(items, "toolCall", "mcp__weather")?.id).toBe("generic");
  });

  it("层内 order 小者胜", () => {
    const items = [item({ id: "a", order: 50 }), item({ id: "b", order: 10 })];
    expect(resolveBlockRenderer(items, "toolCall", "whatever")?.id).toBe("b");
  });

  it("同 order 注册序后者胜(高优先级 source 覆盖内置)", () => {
    const items = [item({ id: "builtin" }), item({ id: "user" })];
    expect(resolveBlockRenderer(items, "toolCall", "whatever")?.id).toBe("user");
  });

  it("无候选 → undefined(消费方落纯文本兜底)", () => {
    expect(resolveBlockRenderer([], "toolCall", "bash")).toBeUndefined();
    expect(resolveBlockRenderer([item({ id: "x", block: "thinking" })], "toolCall", "bash")).toBeUndefined();
  });

  it("无名字的块类型:names 声明是死贡献,通用项命中", () => {
    const items = [item({ id: "dead", block: "thinking", names: ["never"] }), item({ id: "main", block: "thinking" })];
    expect(resolveBlockRenderer(items, "thinking")?.id).toBe("main");
  });
});
