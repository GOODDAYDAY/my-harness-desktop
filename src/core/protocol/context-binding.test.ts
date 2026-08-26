// 投影层时间戳归一测试 —— 针对「底座 ISO 字符串直透传,session-tree relTime
// 拿 NaN 抛 RangeError」的根因修复(entryTimestampMs 契约单源,domain 层)。
// 线形取自底座实证:session-manager 全程 new Date().toISOString()。
import { describe, it, expect } from "vitest";
import { toTreeNode, toMessageEntry, toModelInfo } from "./context-binding";
import { entryTimestampMs } from "@my-harness-desktop/shared";

const ISO = "2026-08-04T09:30:00.123Z";
const EPOCH = Date.parse(ISO);

describe("toTreeNode timestamp 归一", () => {
  it("ISO 字符串 → epoch ms", () => {
    const node = toTreeNode({ entry: { id: "a", type: "message", timestamp: ISO } });
    expect(node.timestamp).toBe(EPOCH);
  });

  it("垃圾字符串 → undefined,不放行 NaN", () => {
    const node = toTreeNode({ entry: { id: "a", type: "message", timestamp: "not-a-date" } });
    expect(node.timestamp).toBeUndefined();
  });

  it("缺 entry / 缺 timestamp → undefined", () => {
    expect(toTreeNode({}).timestamp).toBeUndefined();
    expect(toTreeNode({ entry: { id: "a", type: "message" } }).timestamp).toBeUndefined();
  });

  it("递归子节点同样归一", () => {
    const node = toTreeNode({
      entry: { id: "p", type: "message", timestamp: ISO },
      children: [{ entry: { id: "c", type: "message", timestamp: ISO } }],
    });
    expect(node.children?.[0]?.timestamp).toBe(EPOCH);
  });
});

describe("toMessageEntry timestamp 归一", () => {
  it("ISO 字符串 → epoch ms", () => {
    expect(toMessageEntry({ id: "a", type: "message", timestamp: ISO }).timestamp).toBe(EPOCH);
  });

  it("垃圾字符串 → undefined", () => {
    expect(toMessageEntry({ id: "a", type: "message", timestamp: "garbage" }).timestamp).toBeUndefined();
  });
});

describe("toTreeNode preview 提取(线格式:载荷在顶层,不包 content)", () => {
  it("message 条目从顶层 message 字段取 role/content", () => {
    const node = toTreeNode({
      entry: { id: "a", type: "message", message: { role: "user", content: [{ type: "text", text: "你好\n世界" }] } },
    });
    expect(node.entryType).toBe("user");
    expect(node.preview).toBe("你好");
  });

  it("assistant 无文本块(纯思考+工具调用轮)取工具调用名兜底,不留空白行", () => {
    const node = toTreeNode({
      entry: {
        id: "a", type: "message",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "toolCall", name: "bash" }, { type: "toolCall", name: "read" }] },
      },
    });
    expect(node.entryType).toBe("assistant");
    expect(node.preview).toBe("⚡ bash · read");
  });

  it("toolResult 取 toolName + 输出首行", () => {
    const node = toTreeNode({
      entry: { id: "a", type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "文件内容" }] } },
    });
    expect(node.entryType).toBe("toolResult");
    expect(node.preview).toBe("read: 文件内容");
  });

  it("model_change / thinking_level_change / compaction 从顶层字段取", () => {
    expect(toTreeNode({ entry: { id: "a", type: "model_change", provider: "p", modelId: "m" } }).preview).toBe("p · m");
    expect(toTreeNode({ entry: { id: "a", type: "thinking_level_change", thinkingLevel: "high" } }).preview).toBe("high");
    expect(toTreeNode({ entry: { id: "a", type: "compaction", summary: "摘要首行\n次行" } }).preview).toBe("摘要首行");
  });
});

describe("toModelInfo kernel 来源派生", () => {
  it("pi 后端映射 → kernel 恒为 pi", () => {
    const m = toModelInfo({ provider: "p", id: "gpt-4o", name: "gpt-4o" });
    expect(m.kernel).toBe("pi");
    expect(m.provider).toBe("p");
    expect(m.id).toBe("gpt-4o");
  });

  it("input 透传不丢", () => {
    const m = toModelInfo({ provider: "p", id: "m", name: "m", input: ["text", "image"] });
    expect(m.input).toEqual(["text", "image"]);
  });
});

describe("entryTimestampMs 契约单源", () => {
  it("ISO 字符串 → epoch ms", () => {
    expect(entryTimestampMs(ISO)).toBe(EPOCH);
  });

  it("数字兼容透传,非法值收敛 undefined", () => {
    expect(entryTimestampMs(EPOCH)).toBe(EPOCH);
    expect(entryTimestampMs(NaN)).toBeUndefined();
    expect(entryTimestampMs(undefined)).toBeUndefined();
    expect(entryTimestampMs({})).toBeUndefined();
  });
});
