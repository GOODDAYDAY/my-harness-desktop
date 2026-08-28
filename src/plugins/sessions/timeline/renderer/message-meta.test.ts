// message-meta 纯函数单测:时间/时长/token 投影与边界(无 timestamp/无 usage/负数时长)。
import { describe, it, expect } from "vitest";
import { buildMessageMeta, formatClockTime, formatDurationBrief, formatTokens } from "./message-meta";
import type { NeutralMessage } from "@my-harness-desktop/shared";

const START = Date.parse("2026-08-03T15:13:00.000Z");
const END = Date.parse("2026-08-03T15:13:09.000Z");

describe("formatClockTime", () => {
  it("格式化为 HH:MM:SS(本地时区,小时补零)", () => {
    const d = new Date(2026, 7, 3, 9, 5, 7); // 本地 09:05:07
    expect(formatClockTime(d.getTime())).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatClockTime(d.getTime())).toBe("09:05:07");
  });
});

describe("formatDurationBrief", () => {
  it("毫秒 → ms / s / m 分档", () => {
    expect(formatDurationBrief(999)).toBe("999ms");
    expect(formatDurationBrief(3200)).toBe("3.2s");
    expect(formatDurationBrief(65000)).toBe("1m5s");
  });
});

describe("formatTokens", () => {
  it("千分位以下原样,以上 k", () => {
    expect(formatTokens(567)).toBe("567");
    expect(formatTokens(1234)).toBe("1.2k");
  });
});

describe("buildMessageMeta", () => {
  it("无 timestamp → null(旧数据/占位不假装 0)", () => {
    expect(buildMessageMeta({ role: "user", content: "hi" } as NeutralMessage)).toBeNull();
  });

  it("user 消息 = 仅发送时间(无时长/无 token)", () => {
    const meta = buildMessageMeta({ role: "user", content: "hi", timestamp: START } as NeutralMessage)!;
    expect(meta.clock).toBe(formatClockTime(START));
    expect(meta.duration).toBeUndefined();
    expect(meta.tokens).toBeUndefined();
  });

  it("assistant 消息 = 完成时间 + 总时长(完成-开始)", () => {
    const meta = buildMessageMeta({
      role: "assistant", content: "回复", timestamp: END, startedAt: START,
    } as NeutralMessage)!;
    expect(meta.clock).toBe(formatClockTime(END));
    expect(meta.duration).toBe("9.0s"); // 9000ms
    expect(meta.tokens).toBeUndefined();
  });

  it("assistant 消息带 usage → 补 token 用量(输入/输出)", () => {
    const meta = buildMessageMeta({
      role: "assistant", content: "回复", timestamp: END, startedAt: START,
      usage: { input: 1234, output: 567, totalTokens: 1801 },
    } as unknown as NeutralMessage)!;
    expect(meta.tokens).toEqual({ input: "1.2k", output: "567" });
  });

  it("assistant usage 全 0 → 不展示 token(诚实缺省)", () => {
    const meta = buildMessageMeta({
      role: "assistant", content: "回复", timestamp: END, startedAt: START,
      usage: { input: 0, output: 0, totalTokens: 0 },
    } as unknown as NeutralMessage)!;
    expect(meta.tokens).toBeUndefined();
  });

  it("startedAt 缺失的旧 assistant → 有时钟无时长", () => {
    const meta = buildMessageMeta({ role: "assistant", content: "回复", timestamp: END } as NeutralMessage)!;
    expect(meta.clock).toBe(formatClockTime(END));
    expect(meta.duration).toBeUndefined();
  });
});
