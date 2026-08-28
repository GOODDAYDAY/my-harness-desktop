// @vitest-environment jsdom
// thinking-chain-block 流式计时回归:流式期 label 必须露出实时计时(思考中… + 时长),
// 而非只显示静态「思考中…」——否则用户看不到「计时在增长」(诉求 #5)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ThinkingChainBlock } from "./thinking-chain-block";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh-CN" } }),
}));

describe("ThinkingChainBlock 流式计时", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("流式期 label 露出实时计时(思考中… + 时长),不是只显示静态标签", () => {
    const now = 1700000000000;
    vi.setSystemTime(now);
    render(
      <ThinkingChainBlock
        content={{ type: "thinking", thinking: "在想" }}
        streaming={true}
        startedAt={now - 3200}
      />,
    );
    // t 返回 key:label = "shell.thinkingInProgress"(无时长,首帧 elapsed 尚空)
    expect(screen.getByText(/shell\.thinkingInProgress/)).toBeInTheDocument();
    // 100ms 计时心跳后,label 追加实时时长("shell.thinkingInProgress 3.x s")
    act(() => { vi.advanceTimersByTime(150); });
    expect(screen.getByText(/shell\.thinkingInProgress\s+\d+\.\d+s/)).toBeInTheDocument();
  });

  it("非流式期保持「思考已完成({{duration}})」语义(回归位)", () => {
    vi.setSystemTime(1700000000000);
    render(
      <ThinkingChainBlock
        content={{ type: "thinking", thinking: "在想" }}
        streaming={false}
        startedAt={1000}
        completedAt={4200}
      />,
    );
    expect(screen.getByText(/shell\.thinkingDone/)).toBeInTheDocument();
  });
});
