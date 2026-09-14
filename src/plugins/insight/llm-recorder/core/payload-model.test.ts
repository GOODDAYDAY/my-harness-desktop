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
  it("text/thinking/tool_use/tool_result 各归其类,未知归 other", () => {
    expect(blockToPart({ type: "text", text: "hi" }).kind).toBe("text");
    expect(blockToPart("plain").kind).toBe("text");
    expect(blockToPart({ type: "thinking", thinking: "hmm" }).kind).toBe("thinking");
    expect(blockToPart({ type: "tool_use", name: "read", input: {} }).kind).toBe("toolUse");
    expect(blockToPart({ type: "toolCall", name: "bash", arguments: {} }).kind).toBe("toolUse");
    expect(blockToPart({ type: "image_url", image_url: {} }).kind).toBe("other");
  });

  it("★ 形状词典:dsh 的 reasoning/tool-call/tool-result 与 provider 原生同归一类", () => {
    // dsh 的思考块：文本在 .text（原生 thinking 放在 .thinking）
    const think = blockToPart({ type: "reasoning", text: "先看目录结构" });
    expect(think.kind).toBe("thinking");
    expect(think.raw).toBe("先看目录结构");
    // dsh 的工具调用：arguments 是 **JSON 字符串**，预览不该再套一层转义
    const call = blockToPart({ type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' });
    expect(call.kind).toBe("toolUse");
    expect(call.title).toBe("bash");
    expect(call.preview).toBe('{"command":"ls"}');
    // dsh 的工具结果：连字符 + isError（原生是下划线 + is_error）
    const res = blockToPart({ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "a.txt" }], isError: true });
    expect(res.kind).toBe("toolResult");
    expect(res.isError).toBe(true);
    expect(res.title).toBe("a.txt");
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
    expect(v.parts.map((p) => p.kind)).toEqual(["thinking", "text", "toolUse"]);
    expect(v.parts[2].title).toBe("bash");
  });

  it("★ dsh 请求体:provider 单独成行,不再在 params 里重复出现", () => {
    const v = describeRequest({
      provider: "us-new", model: "deepseek-v4-pro", messages: [],
      system: "s", tools: [], temperature: 0.3, sessionId: "sid-1",
    });
    expect(v.provider).toBe("us-new");
    expect(v.params.map((p) => p.key), "provider/model/messages/system/tools 各有各的位置").toEqual(["temperature", "sessionId"]);
  });

  it("★ dsh 组装态消息:同形状词典一把认下,usage 键名并列 + 派生总量", () => {
    const v = describeResponse({
      role: "assistant",
      provider: "us-new",
      model: "deepseek-v4-pro",
      stopReason: "tool-calls",
      usage: { inputTokens: 1200, outputTokens: 34, cacheReadTokens: 900 },
      content: [
        { type: "reasoning", text: "让我想想" },
        { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' },
      ],
    });
    expect(v.recognized).toBe(true);
    expect(v.stopReason).toBe("tool-calls");
    expect(v.provider).toBe("us-new");
    expect(v.usage).toMatchObject({ input: 1200, output: 34, cacheRead: 900 });
    expect(v.usage?.totalTokens, "dsh 分项互斥且不给总量 → 按四项之和派生").toBe(1200 + 34 + 900);
    expect(v.parts.map((p) => p.kind)).toEqual(["thinking", "toolUse"]);
  });

  it("★ 没有响应消息 ≠ 形状不认识:absent 与 shape 必须分开", () => {
    // dsh 失败/中止：行上根本没有 message 字段
    const absent = describeResponse(undefined);
    expect(absent.recognized).toBe(false);
    expect(absent.unrecognizedReason, "内核没给 → 'absent',面板要说「没有回传响应消息」").toBe("absent");
    // 给了但形状不认识 → 'shape'
    expect(describeResponse({ role: "assistant" }).unrecognizedReason).toBe("shape");
    expect(describeResponse(null).unrecognizedReason).toBe("absent");
  });

  it("content 不是数组 → recognized=false", () => {
    expect(describeResponse({ role: "assistant" }).recognized).toBe(false);
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
