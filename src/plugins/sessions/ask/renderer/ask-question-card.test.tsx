// @vitest-environment jsdom
// AskQuestionCard DOM 测试 —— 真实渲染 + 真实交互，覆盖「提问进 timeline」的完整闭环：
// 运行中（toolCall.state=running）订阅 onQuestion → 渲染问题气泡 + 选项 chips → 点选/输入 → 提交回填 answerQuestion；
// 结算后（result.answers）渲染 N/M answered 摘要。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { Question, QuestionRequestEvent } from "@my-harness-desktop/shared";

const mocks = vi.hoisted(() => ({
  answerQuestion: vi.fn(),
  onQuestionCb: null as ((req: QuestionRequestEvent) => void) | null,
}));

vi.mock("@my-harness-desktop/react", () => {
  const sessions = {
    onQuestion: (cb: (req: QuestionRequestEvent) => void) => {
      mocks.onQuestionCb = cb;
      return () => { mocks.onQuestionCb = null; };
    },
    answerQuestion: mocks.answerQuestion,
  };
  return { usePluginContext: () => ({ sessions }) };
});

import { AskQuestionCard } from "./ask-question-card";

function fireQuestion(questions: Question[]): void {
  act(() => {
    mocks.onQuestionCb?.({ kind: "question", requestId: "req-1", sessionKey: "", questions });
  });
}

describe("AskQuestionCard（提问进 timeline）", () => {
  beforeEach(() => {
    mocks.answerQuestion.mockReset();
    mocks.answerQuestion.mockResolvedValue(undefined);
    mocks.onQuestionCb = null;
  });

  it("运行中：渲染问题气泡 + 选项 chips，点选 + 提交回填答案", async () => {
    render(<AskQuestionCard toolCall={{ name: "ask_user_question", state: "running" }} collapseDefault={true} />);
    fireQuestion([
      { id: "q1", question: "选哪个方案？", options: [{ label: "A 方案" }, { label: "B 方案" }] },
    ]);

    // 问题正文 + 两个选项 chip 都渲染出来（不是只给输入框）
    expect(screen.getByText("选哪个方案？")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "A 方案" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "B 方案" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "A 方案" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(mocks.answerQuestion).toHaveBeenCalledWith("req-1", [{ id: "q1", selected: ["A 方案"] }]);
    });
  });

  it("运行中：无选项问题走自定义输入，提交回填 custom", async () => {
    render(<AskQuestionCard toolCall={{ name: "ask_user_question", state: "running" }} collapseDefault={true} />);
    fireQuestion([{ id: "q1", question: "补充点信息？" }]);

    fireEvent.change(screen.getByPlaceholderText("输入你的答案"), { target: { value: "我的补充" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(mocks.answerQuestion).toHaveBeenCalledWith("req-1", [{ id: "q1", selected: [], custom: "我的补充" }]);
    });
  });

  it("运行中：跳过本题回填空 selected", async () => {
    render(<AskQuestionCard toolCall={{ name: "ask_user_question", state: "running" }} collapseDefault={true} />);
    fireQuestion([{ id: "q1", question: "要跳过的问题？", options: [{ label: "A" }] }]);

    fireEvent.click(screen.getByRole("button", { name: "跳过本题" }));

    await waitFor(() => {
      expect(mocks.answerQuestion).toHaveBeenCalledWith("req-1", [{ id: "q1", selected: [] }]);
    });
  });

  it("结算后：渲染 N/M answered 摘要", () => {
    render(
      <AskQuestionCard
        toolCall={{ name: "ask_user_question", state: "done", result: { answers: [{ id: "q1", selected: ["A"] }, { id: "q2", custom: "x" }] } }}
        collapseDefault={true}
      />,
    );
    expect(screen.getByText("2/2 answered")).toBeInTheDocument();
  });
});
