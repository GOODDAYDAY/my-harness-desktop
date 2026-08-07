import { describe, expect, it } from "vitest";
import {
  blockToPart, byteSize, contentToParts, describeRequest, describeResponse,
  firstLineOf, peekUsage, previewOf, toolParams,
} from "./payload-model";

describe("byteSize", () => {
  it("按 UTF-8 字节计,中文不是 1 字符 1 字节", () => {
    expect(byteSize("a")).toBe(3); // JSON 带两个引号
    expect(byteSize("中")).toBe(5); // 引号 2 + UTF-8 中文 3
    expect(byteSize(undefined)).toBe(0);
  });
});

describe("previewOf / firstLineOf", () => {
  it("预览压扁空白并截断;标题取首个非空行", () => {
    expect(previewOf("a\n\nb   c")).toBe("a b c");
    expect(previewOf("x".repeat(300))).toHaveLength(241); // 240 + 省略号
    expect(firstLineOf("\n  \nhello\nworld")).toBe("hello");
    expect(firstLineOf("")).toBe("");
  });
});

describe("blockToPart", () => {
  it("text/thinking/tool_use/tool_result/toolCall 各归其类,未知归 other", () => {
    expect(blockToPart({ type: "text", text: "hi" }).kind).toBe("text");
    expect(blockToPart("plain").kind).toBe("text");
    expect(blockToPart({ type: "thinking", thinking: "hmm" }).kind).toBe("thinking");
    expect(blockToPart({ type: "tool_use", name: "read", input: {} }).kind).toBe("toolUse");
    expect(blockToPart({ type: "toolCall", name: "bash", arguments: {} }).kind).toBe("toolCall");
    expect(blockToPart({ type: "image_url", image_url: {} }).kind).toBe("other");
  });

  it("tool_result 抽块数组里的文本做预览,is_error 进 isError", () => {
    const part = blockToPart({
      type: "tool_result", tool_use_id: "x", is_error: true,
      content: [{ type: "text", text: "boom" }],
    });
    expect(part.kind).toBe("toolResult");
    expect(part.preview).toBe("boom");
    expect(part.isError).toBe(true);
  });
});

describe("contentToParts", () => {
  it("string / 块数组 / 缺失 三种形态", () => {
    expect(contentToParts("abc")).toHaveLength(1);
    expect(contentToParts([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toHaveLength(2);
    expect(contentToParts(undefined)).toHaveLength(0);
    expect(contentToParts("")).toHaveLength(0);
  });
});

describe("describeRequest", () => {
  const anthropicPayload = {
    model: "m-1",
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "你是 pi" }],
    tools: [
      {
        name: "read", description: "读文件",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            limit: { type: "number" },
            edits: { type: "array", items: { type: "object" } },
          },
          required: ["path"],
        },
      },
      { name: "bash", input_schema: {} },
    ],
    messages: [
      { role: "user", content: "看下代码" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  };

  it("Anthropic 形状全量拆解,model/params/system/tools/messages 各就各位", () => {
    const v = describeRequest(anthropicPayload);
    expect(v.recognized).toBe(true);
    expect(v.model).toBe("m-1");
    expect(v.params.map((p) => p.key).sort()).toEqual(["max_tokens", "stream"]);
    expect(v.system).toHaveLength(1);
    expect(v.system[0].text).toBe("你是 pi");
    expect(v.tools.map((t) => t.name)).toEqual(["read", "bash"]);
    expect(v.tools[0].description).toBe("读文件");
    expect(v.tools[0].params).toEqual([
      { name: "path", type: "string", required: true, description: "文件路径" },
      { name: "limit", type: "number", required: false, description: undefined },
      { name: "edits", type: "array<object>", required: false, description: undefined },
    ]);
    expect(v.tools[1].description).toBeUndefined();
    expect(v.tools[1].params).toEqual([]);
    expect(v.messages).toHaveLength(3);
    expect(v.messages[0].parts[0].kind).toBe("text");
    expect(v.messages[1].parts[0].kind).toBe("toolUse");
    expect(v.messages[2].parts[0].kind).toBe("toolResult");
    expect(v.systemBytes).toBeGreaterThan(0);
    expect(v.toolsBytes).toBeGreaterThan(0);
    expect(v.messagesBytes).toBeGreaterThan(0);
  });

  it("OpenAI 形状:工具名/description/parameters 从 function 里取", () => {
    const v = describeRequest({
      model: "gpt-x",
      tools: [{
        type: "function",
        function: {
          name: "search", description: "搜索",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(v.recognized).toBe(true);
    expect(v.tools[0].name).toBe("search");
    expect(v.tools[0].description).toBe("搜索");
    expect(v.tools[0].params).toEqual([{ name: "q", type: "string", required: true, description: undefined }]);
  });

  it("system 是裸 string 也收", () => {
    const v = describeRequest({ system: "sys", messages: [] });
    expect(v.system).toHaveLength(1);
    expect(v.system[0].text).toBe("sys");
  });

  it("非对象或无 messages 数组 → recognized=false", () => {
    expect(describeRequest("garbage").recognized).toBe(false);
    expect(describeRequest({ model: "m" }).recognized).toBe(false);
    expect(describeRequest(null).recognized).toBe(false);
  });
});

describe("peekUsage", () => {
  it("提取数值字段与 cost.total;无 usage 返回 undefined", () => {
    const u = peekUsage({ usage: { input: 10, output: 5, cacheRead: 100, totalTokens: 115, cost: { total: 0.2 } } });
    expect(u).toEqual({ input: 10, output: 5, cacheRead: 100, cacheWrite: undefined, totalTokens: 115, cost: 0.2 });
    expect(peekUsage({ role: "assistant" })).toBeUndefined();
    expect(peekUsage({ usage: {} })).toBeUndefined();
  });
});

describe("describeResponse", () => {
  it("pi 组装态消息:块拆解 + usage + stopReason", () => {
    const v = describeResponse({
      role: "assistant",
      model: "m-1",
      stopReason: "stop",
      usage: { input: 1, output: 2, totalTokens: 3 },
      content: [
        { type: "thinking", thinking: "让我想想" },
        { type: "text", text: "答案" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      ],
    });
    expect(v.recognized).toBe(true);
    expect(v.stopReason).toBe("stop");
    expect(v.usage?.totalTokens).toBe(3);
    expect(v.parts.map((p) => p.kind)).toEqual(["thinking", "text", "toolCall"]);
    expect(v.parts[2].title).toBe("bash");
  });

  it("content 不是数组 → recognized=false", () => {
    expect(describeResponse({ role: "assistant" }).recognized).toBe(false);
    expect(describeResponse(null).recognized).toBe(false);
  });
});

describe("toolParams", () => {
  it("properties/required 缺失或形状不认 → 空列表", () => {
    expect(toolParams(undefined)).toEqual([]);
    expect(toolParams({})).toEqual([]);
    expect(toolParams({ type: "object" })).toEqual([]);
    expect(toolParams({ properties: "nope" })).toEqual([]);
  });
});
