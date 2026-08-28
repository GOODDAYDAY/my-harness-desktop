// @vitest-environment jsdom
// MessageMeta DOM 渲染测试:真实组件挂载,验证时间/时长/token 徽标内容与 aria 锚点。
// hover 显隐是 CSS 语义(opacity-0 → group-hover:opacity-100),jsdom 不模拟 hover,
// 这里验证内容与锚点渲染正确(视觉显隐由全栈 e2e 的 screenshot 覆盖)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MessageMeta } from "./MessageMeta";
import type { NeutralMessage } from "@my-harness-desktop/shared";

const START = Date.parse("2026-08-03T15:13:00.000Z");
const END = Date.parse("2026-08-03T15:13:09.000Z");

describe("MessageMeta DOM 渲染", () => {
  it("无 timestamp 的消息不渲染徽标", () => {
    const { container } = render(<MessageMeta message={{ role: "user", content: "hi" } as NeutralMessage} />);
    expect(container.querySelector('[aria-label="message-meta"]')).toBeNull();
  });

  it("user 消息渲染发送时间(无时长/无 token)", () => {
    const { container } = render(
      <MessageMeta message={{ role: "user", content: "hi", timestamp: START } as NeutralMessage} />,
    );
    const el = container.querySelector('[aria-label="message-meta"]')!;
    expect(el).not.toBeNull();
    expect(el.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(el.textContent).not.toContain("·"); // 无时长、无 token
  });

  it("assistant 消息渲染完成时间 + 总时长 + token 用量", () => {
    const { container } = render(
      <MessageMeta
        message={{
          role: "assistant", content: "回复", timestamp: END, startedAt: START,
          usage: { input: 1234, output: 567, totalTokens: 1801 },
        } as unknown as NeutralMessage}
      />,
    );
    const el = container.querySelector('[aria-label="message-meta"]')!;
    // "HH:MM:SS · 9.0s · ↑1.2k ↓567"
    expect(el.textContent).toMatch(/\d{2}:\d{2}:\d{2} · 9\.0s · ↑1\.2k ↓567/);
    expect(el.getAttribute("title")).toContain("↑1.2k ↓567");
  });
});
