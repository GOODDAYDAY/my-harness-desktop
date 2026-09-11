// @vitest-environment jsdom
// 工具卡「运行中图标明暗交替」守卫(诉求 15:只要运行中,图标要么动、要么明暗交替)。
//
// 根因背景:整卡此前只有「running」文案的 shimmer + 左侧呼吸条,而**工具图标本身是静态的**
// ——用户看到的是"在执行"的提示,但那个图标不动,不满足"逐图标"的纪律。修法=图标挂
// animate-pulse(isStreaming 时),本文件锁住这条不变式。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { ToolCallBlock } from "@my-harness-desktop/shared";
import { DefaultCard, BashCard } from "./tool-cards";

/** 只喂本断言用得到的字段:卡片读 state(判运行态)与 name(选图标)。 */
const running = { state: "running", name: "read", input: {}, id: "t1" } as unknown as ToolCallBlock;
const done = { state: "completed", name: "read", input: {}, id: "t1", result: "ok" } as unknown as ToolCallBlock;

/** 卡片里带 svg 且挂 animate-pulse 的图标 span —— 就是"运行中图标在闪"。 */
function pulsingIconCount(container: HTMLElement): number {
  return [...container.querySelectorAll("span.animate-pulse")].filter((s) => s.querySelector("svg")).length;
}

describe("工具卡运行中图标明暗交替(诉求 15)", () => {
  it("DefaultCard:运行中工具图标挂 animate-pulse(不是静态)", () => {
    const { container } = render(<DefaultCard toolCall={running} />);
    expect(pulsingIconCount(container)).toBeGreaterThan(0);
  });

  it("DefaultCard:完成后图标不再闪(静态)", () => {
    const { container } = render(<DefaultCard toolCall={done} />);
    expect(pulsingIconCount(container)).toBe(0);
  });

  it("BashCard:运行中图标同样明暗交替(卡片变体不得漏)", () => {
    const { container } = render(<BashCard toolCall={{ ...running, name: "bash" } as unknown as ToolCallBlock} />);
    expect(pulsingIconCount(container)).toBeGreaterThan(0);
  });
});
