// @vitest-environment jsdom
// thinking-chain-block 流式计时回归:流式期 label 必须露出实时计时(思考中… + 时长),
// 而非只显示静态「思考中…」——否则用户看不到「计时在增长」(诉求 #5)。
// 另锁两条展示回归:
//  ① 完成态空思考块(供应商回空 thinking 帧)不渲染可点展开器——死控件曾让用户
//    「点击没用、不展开、点开也看不到」(空正文展开成零高度空白);
//  ② 有正文的完成态块点击展开全文(不截断)、再点收起——「点击展开」能力的对账。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ThinkingChainBlock } from "./thinking-chain-block";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, args?: Record<string, unknown>) => (args ? `${k}(${JSON.stringify(args)})` : k), i18n: { language: "zh-CN" } }),
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

  it("完成态空思考块:不渲染可点展开器,显式提示无思考内容(保留时长)", () => {
    vi.setSystemTime(1700000000000);
    render(
      <ThinkingChainBlock
        content={{ type: "thinking", thinking: "" }}
        streaming={false}
        startedAt={1000}
        completedAt={4200}
      />,
    );
    // 无按钮(死控件是「点击没用」观感的根因),有显式空内容提示 + 时长标签
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/shell\.thinkingEmpty/)).toBeInTheDocument();
    expect(screen.getByText(/shell\.thinkingDone/)).toBeInTheDocument();
  });

  it("思考中(streaming)运行态图标明暗交替(animate-pulse,§目标 15)", () => {
    const { container } = render(
      <ThinkingChainBlock content={{ type: "thinking", thinking: "在想" }} streaming={true} />,
    );
    // 运行中态必须有「动的 icon/明暗交替」:至少一个 svg(Brain)挂 animate-pulse。
    expect([...container.querySelectorAll("svg")].some((s) => s.classList.contains("animate-pulse"))).toBe(true);
  });

  it("非流式无运行态动画(静态 icon)", () => {
    const { container } = render(
      <ThinkingChainBlock content={{ type: "thinking", thinking: "在想" }} streaming={false} startedAt={1000} completedAt={4200} />,
    );
    expect([...container.querySelectorAll("svg")].some((s) => s.classList.contains("animate-pulse"))).toBe(false);
  });

  it("完成态有正文:点击展开全文(多行不截断),再点收起", () => {
    vi.setSystemTime(1700000000000);
    const full = "第一段\n第二段\n第三段";
    render(
      <ThinkingChainBlock
        content={{ type: "thinking", thinking: full }}
        streaming={false}
        startedAt={1000}
        completedAt={4200}
        collapseDefault={true}
      />,
    );
    // 默认折叠:正文不在
    expect(screen.queryByText(/第一段/)).not.toBeInTheDocument();
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    // 展开:全文逐字都在(无任何截断)
    expect(screen.getByText(/第一段/)).toBeInTheDocument();
    expect(screen.getByText(/第三段/)).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByText(/第一段/)).not.toBeInTheDocument();
  });
});
