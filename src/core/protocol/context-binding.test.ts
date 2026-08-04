// toTreeNode/toMessageEntry 时间戳归一测试 —— 针对「底座 ISO 字符串直透传,
// session-tree relTime 拿 NaN 抛 RangeError」的根因修复。
// 线形取自底座 session-manager 实证:entry.timestamp 全程 new Date().toISOString()。
import { describe, it, expect } from "vitest";
import { toTreeNode, toMessageEntry } from "./context-binding";

const ISO = "2026-08-04T09:30:00.123Z";
const EPOCH = Date.parse(ISO);

describe("toTreeNode timestamp 归一", () => {
  it("ISO 字符串 → epoch ms", () => {
    const node = toTreeNode({ entry: { id: "a", type: "message", timestamp: ISO } });
    expect(node.timestamp).toBe(EPOCH);
  });

  it("数字原样透传(防御未来底座改线形)", () => {
    const node = toTreeNode({ entry: { id: "a", type: "message", timestamp: EPOCH } });
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
    const e = toMessageEntry({ id: "a", type: "message", timestamp: ISO });
    expect(e.timestamp).toBe(EPOCH);
  });

  it("垃圾值 → undefined", () => {
    expect(toMessageEntry({ id: "a", type: "message", timestamp: "garbage" }).timestamp).toBeUndefined();
    expect(toMessageEntry({ id: "a", type: "message", timestamp: NaN }).timestamp).toBeUndefined();
  });
});
