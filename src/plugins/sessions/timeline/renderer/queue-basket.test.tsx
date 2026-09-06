// @vitest-environment jsdom
// 排队篮(timeline.queue)DOM 交互测试(三级测试第二级,补 r331 e2e 的组件层缺口):
//   空队不渲染/标题计数/立即发送(打断语义)/逐条取消/首条失败的重试提示与暂停提示/清空全部。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueueBasket } from "./queue-basket";
import type { QueuedMessage } from "@my-harness-desktop/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => {
    const dict: Record<string, string> = {
      "timeline.queue.title": `排队 (${opts?.count ?? 0})`,
      "timeline.queue.hint": "AI 完成后合并发送",
      "timeline.queue.sendNow": "立即发送",
      "timeline.queue.sendNowHint": "打断当前回复,立即发送这条",
      "timeline.queue.editHint": "点击编辑",
      "timeline.queue.cancel": "取消",
      "timeline.queue.failed": `合并发送失败:${opts?.error ?? ""}`,
      "timeline.queue.retry": "重试合并发送",
      "timeline.queue.clearAll": "清空全部",
      "timeline.queue.pausedHint": "处理失败后继续",
    };
    return dict[k] ?? k;
  } }),
}));

const item = (over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: "q1", text: "排队的第一条", displayText: undefined, attachments: undefined,
  queuedAt: 1, failed: false, errMsg: undefined, ...over,
} as QueuedMessage);

function makeHandlers() {
  return { onEdit: vi.fn(), onRemove: vi.fn(), onSendNow: vi.fn(), onRetry: vi.fn(), onClearAll: vi.fn() };
}

describe("QueueBasket 空态", () => {
  beforeEach(cleanup);
  it("空队不渲染(null)", () => {
    const h = makeHandlers();
    const { container } = render(<QueueBasket items={[]} visibleCount={5} {...h} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("QueueBasket 条目渲染与计数", () => {
  beforeEach(cleanup);
  it("标题带计数;条目文本与序号可见", () => {
    const h = makeHandlers();
    render(<QueueBasket items={[item(), item({ id: "q2", text: "第二条" })]} visibleCount={5} {...h} />);
    expect(screen.getByText("排队 (2)")).toBeInTheDocument();
    expect(screen.getByText("AI 完成后合并发送")).toBeInTheDocument();
    expect(screen.getByText("排队的第一条")).toBeInTheDocument();
    expect(screen.getByText("第二条")).toBeInTheDocument();
  });

  it("displayText 优先于 text(评论-only 等展示文案形态)", () => {
    const h = makeHandlers();
    render(<QueueBasket items={[item({ displayText: "评论 3 条" })]} visibleCount={5} {...h} />);
    expect(screen.getByText("评论 3 条")).toBeInTheDocument();
  });
});

describe("QueueBasket 逐条动作", () => {
  beforeEach(cleanup);
  it("点条目文本 = onEdit(item)(就地编辑入口)", () => {
    const h = makeHandlers();
    render(<QueueBasket items={[item()]} visibleCount={5} {...h} />);
    fireEvent.click(screen.getByText("排队的第一条"));
    expect(h.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "q1" }));
  });

  it("「立即发送」onSendNow(item)——打断当前生成只发这条的按钮契约", () => {
    const h = makeHandlers();
    render(<QueueBasket items={[item()]} visibleCount={5} {...h} />);
    fireEvent.click(screen.getByTitle("打断当前回复,立即发送这条"));
    expect(h.onSendNow).toHaveBeenCalledWith(expect.objectContaining({ id: "q1" }));
  });

  it("「✕」onRemove(id)(逐条取消)", () => {
    const h = makeHandlers();
    render(<QueueBasket items={[item(), item({ id: "q2", text: "二" })]} visibleCount={5} {...h} />);
    fireEvent.click(screen.getAllByTitle("取消")[1]);
    expect(h.onRemove).toHaveBeenCalledWith("q2");
  });

  it("「清空全部」onClearAll()", () => {
    const h = makeHandlers();
    render(<QueueBasket items={[item()]} visibleCount={5} {...h} />);
    fireEvent.click(screen.getByText("清空全部"));
    expect(h.onClearAll).toHaveBeenCalledTimes(1);
  });
});

describe("QueueBasket 失败态", () => {
  beforeEach(cleanup);
  it("首条失败:错误行(带错误原文)+「重试合并发送」按钮,重试命中 onRetry", () => {
    const h = makeHandlers();
    render(<QueueBasket items={[item({ failed: true, errMsg: "内核未启动" })]} visibleCount={5} {...h} />);
    expect(screen.getByText(/合并发送失败:内核未启动/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("重试合并发送"));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
  });

  it("多条且含失败:暂停提示显形(处理失败后继续)", () => {
    const h = makeHandlers();
    render(<QueueBasket items={[item({ failed: true, errMsg: "x" }), item({ id: "q2", text: "二" })]} visibleCount={5} {...h} />);
    expect(screen.getByText("处理失败后继续")).toBeInTheDocument();
  });

  it("无失败:暂停提示不显形", () => {
    const h = makeHandlers();
    render(<QueueBasket items={[item()]} visibleCount={5} {...h} />);
    expect(screen.queryByText("处理失败后继续")).toBeNull();
  });
});
