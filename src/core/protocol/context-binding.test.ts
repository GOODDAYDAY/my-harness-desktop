// 投影层时间戳归一测试 —— 针对「底座 ISO 字符串直透传,session-tree relTime
// 拿 NaN 抛 RangeError」的根因修复(entryTimestampMs 契约单源,domain 层)。
// 线形取自底座实证:session-manager 全程 new Date().toISOString()。
import { describe, it, expect } from "vitest";
import { toTreeNode, toMessageEntry } from "./context-binding";
import { entryTimestampMs } from "../domain/events/session-state";

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
