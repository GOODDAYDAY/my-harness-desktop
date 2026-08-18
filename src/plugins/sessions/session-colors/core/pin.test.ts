import { describe, it, expect } from "vitest";
import type { NeutralMessage } from "@my-harness-desktop/contract";
import {
  messagePreview, groupContentPins, backfillPreviews, type ContentPin,
} from "./pin";

function msg(id: string, content: unknown, over: Partial<NeutralMessage> = {}): NeutralMessage {
  return { role: "user", id, content, ...over };
}

function pin(id: string, messageId: string, color = "#f38ba8", over: Partial<ContentPin> = {}): ContentPin {
  return { id, messageId, color, x: 50, y: 50, ...over };
}

describe("messagePreview", () => {
  it("折叠空白并截前 30 字", () => {
    const m = msg("m1", "  第一段\n\n第二段   很长 ".padEnd(80, "字"));
    expect(messagePreview(m)).toHaveLength(30);
    expect(messagePreview(msg("m2", "a\n\n  b"))).toBe("a b");
  });

  it("内容块数组只取 text 块", () => {
    const m = msg("m1", [
      { type: "thinking", thinking: "想" },
      { type: "text", text: "可见文本" },
      { type: "toolCall", toolName: "bash" },
    ]);
    expect(messagePreview(m)).toBe("可见文本");
  });

  it("无文本时退 i18nKey,再退 role", () => {
    expect(messagePreview({ role: "assistant", content: [], i18nKey: "timeline.compacted" })).toBe("timeline.compacted");
    expect(messagePreview({ role: "toolResult", content: [] })).toBe("toolResult");
  });
});

describe("groupContentPins 跨会话聚合", () => {
  const MESSAGES = [msg("m1", "第一条"), msg("m2", "第二条"), msg("m3", "第三条")];
  const PROJECT = ["/s/a.jsonl", "/s/b.jsonl", "/s/c.jsonl"];

  it("当前会话:孤儿钉不列,按消息序排序(不按钉入序)", () => {
    const groups = groupContentPins({
      "/s/a.jsonl": [pin("p2", "m3"), pin("p1", "m1"), pin("orphan", "m-gone")],
    }, "/s/a.jsonl", MESSAGES, PROJECT, null);
    expect(groups).toHaveLength(1);
    expect(groups[0].isCurrent).toBe(true);
    expect(groups[0].entries.map((e) => e.pin.id)).toEqual(["p1", "p2"]);
    expect(groups[0].entries.every((e) => e.message !== undefined)).toBe(true);
  });

  it("当前会话:display=false 的消息不列", () => {
    const groups = groupContentPins({
      "/s/a.jsonl": [pin("p1", "m2")],
    }, "/s/a.jsonl", [msg("m1", "x"), msg("m2", "y", { display: false })], PROJECT, null);
    expect(groups).toHaveLength(0);
  });

  it("其他会话:只列 projectPaths 内的,按 projectPaths 顺序,孤儿钉保留", () => {
    const groups = groupContentPins({
      "/s/c.jsonl": [pin("pc", "m-x")],
      "/s/b.jsonl": [pin("pb", "m-y")],
      "/other/proj/z.jsonl": [pin("pz", "m-z")],
    }, "/s/a.jsonl", MESSAGES, PROJECT, null);
    expect(groups.map((g) => g.path)).toEqual(["/s/b.jsonl", "/s/c.jsonl"]);
    expect(groups.every((g) => !g.isCurrent)).toBe(true);
    expect(groups.every((g) => g.entries.every((e) => e.message === undefined))).toBe(true);
  });

  it("当前会话组恒在最前,即使不在 projectPaths(列表异步未达)", () => {
    const groups = groupContentPins({
      "/s/b.jsonl": [pin("pb", "m-y")],
      "/s/a.jsonl": [pin("pa", "m1")],
    }, "/s/a.jsonl", MESSAGES, ["/s/b.jsonl"], null);
    expect(groups.map((g) => g.path)).toEqual(["/s/a.jsonl", "/s/b.jsonl"]);
  });

  it("颜色过滤对两段同时生效,过滤后为空的组不列", () => {
    const groups = groupContentPins({
      "/s/a.jsonl": [pin("pa", "m1", "#f38ba8")],
      "/s/b.jsonl": [pin("pb", "m-y", "#89b4fa")],
    }, "/s/a.jsonl", MESSAGES, PROJECT, "#89b4fa");
    expect(groups.map((g) => g.path)).toEqual(["/s/b.jsonl"]);
  });

  it("无钉返回空数组", () => {
    expect(groupContentPins({}, "/s/a.jsonl", MESSAGES, PROJECT, null)).toEqual([]);
    expect(groupContentPins({}, null, [], [], null)).toEqual([]);
  });
});

describe("backfillPreviews 惰性补填", () => {
  const MESSAGES = [msg("m1", "补填来源")];

  it("缺 preview 且消息可解析时补填,已有 preview 不动", () => {
    const pins = [pin("p1", "m1"), pin("p2", "m2", "#89b4fa", { preview: "旧快照" })];
    const next = backfillPreviews(pins, [...MESSAGES, msg("m2", "新文本")]);
    expect(next?.[0].preview).toBe("补填来源");
    expect(next?.[1].preview).toBe("旧快照");
  });

  it("无缺 preview 的钉时返回 null(不触发写盘)", () => {
    expect(backfillPreviews([pin("p1", "m1", "#f38ba8", { preview: "有" })], MESSAGES)).toBeNull();
  });

  it("缺 preview 但消息不可解析(孤儿)时返回 null", () => {
    expect(backfillPreviews([pin("p1", "m-gone")], MESSAGES)).toBeNull();
  });
});
