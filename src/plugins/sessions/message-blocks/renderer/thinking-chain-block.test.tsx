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
import { ThinkingChainBlock, resetThinkingOpenOverride } from "./thinking-chain-block";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, args?: Record<string, unknown>) => (args ? `${k}(${JSON.stringify(args)})` : k), i18n: { language: "zh-CN" } }),
}));

describe("ThinkingChainBlock 流式计时", () => {
  // 粘性覆盖是模块级状态：不逐例复位会让「谁先跑」决定结果（守卫互相污染）。
  beforeEach(() => { vi.useFakeTimers(); resetThinkingOpenOverride(); });
  afterEach(() => { vi.useRealTimers(); resetThinkingOpenOverride(); });

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

  it("默认折叠不随流式自动翻转:流式中保持折叠、结束不自动收起(用户诉求 #18 守卫)", () => {
    vi.setSystemTime(1700000000000);
    const full = "思考正文第一段";
    const { rerender } = render(
      <ThinkingChainBlock content={{ type: "thinking", thinking: full }} streaming={true} startedAt={1000} collapseDefault={true} />,
    );
    // 流式中:保持默认折叠(此前实现流式中强制展开,用户嫌跳)
    expect(screen.queryByText(new RegExp(full))).not.toBeInTheDocument();
    // 用户手动展开
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(new RegExp(full))).toBeInTheDocument();
    // 流式结束:保持展开(此前实现回落折叠默认 →「看着看着自动收起」的根因)
    rerender(
      <ThinkingChainBlock content={{ type: "thinking", thinking: full }} streaming={false} startedAt={1000} completedAt={4200} collapseDefault={true} />,
    );
    expect(screen.getByText(new RegExp(full))).toBeInTheDocument();
  });

  // 上面那条用的是 rerender()——**同一个组件实例**，state 天然保留，所以它今天绿、
  // 却抓不到真实缺陷：真实路径上这行会在定稿瞬间被 Virtuoso **重挂**（computeItemKey 用
  // 消息 id，而 id 从流 id/stream-N 变成 neutralEntryId，必然不相等）→ 局部 state 归零 →
  // 用户手动展开的那块「跑完又自己合上了」。
  // 下面这条用 unmount + 全新 render 复现重挂（等价于换了 key 的新实例）。
  it("定稿重挂后仍保持展开（真实缺陷形态：Virtuoso key 变化 = 换实例，局部 state 会归零）", () => {
    vi.setSystemTime(1700000000000);
    const full = "重挂也不能合上";
    const view = (): React.ReactElement => (
      <ThinkingChainBlock content={{ type: "thinking", thinking: full }} streaming={false} startedAt={1000} completedAt={4200} collapseDefault={true} />
    );
    const first = render(view());
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(new RegExp(full))).toBeInTheDocument();
    // 重挂（= 定稿换 key）：卸载再挂一个全新实例，局部 state 从零开始
    first.unmount();
    render(view());
    expect(
      screen.getByText(new RegExp(full)),
      "重挂后回到折叠默认——这正是「跑完又自己收起来」的根因；用户的开合意图必须粘住",
    ).toBeInTheDocument();
  });

  it("默认仍然是折叠的（重挂不改变「默认收起来」）", () => {
    resetThinkingOpenOverride();
    const full = "默认收起来";
    render(<ThinkingChainBlock content={{ type: "thinking", thinking: full }} streaming={false} startedAt={1000} completedAt={4200} collapseDefault={true} />);
    expect(screen.queryByText(new RegExp(full))).not.toBeInTheDocument();
  });
});
