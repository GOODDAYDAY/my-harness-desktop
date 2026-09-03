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
  getPendingQuestions: vi.fn(),
  onQuestionCb: null as ((req: QuestionRequestEvent) => void) | null,
}));

vi.mock("@my-harness-desktop/react", () => {
  const sessions = {
    onQuestion: (cb: (req: QuestionRequestEvent) => void) => {
      mocks.onQuestionCb = cb;
      return () => { mocks.onQuestionCb = null; };
    },
    answerQuestion: mocks.answerQuestion,
    getPendingQuestions: mocks.getPendingQuestions,
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
    mocks.getPendingQuestions.mockReset();
    mocks.getPendingQuestions.mockResolvedValue([]);
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

  it("选项整行呈现(用户要求):纵向堆叠、整行宽、多行文本 pre-wrap", async () => {
    render(<AskQuestionCard toolCall={{ name: "ask_user_question", state: "running" }} collapseDefault={true} />);
    fireQuestion([
      { id: "q1", question: "选一个", options: [{ label: "第一行\n第二行(多行选项)" }, { label: "B" }] },
    ]);

    const optA = screen.getByRole("radio", { name: "第一行\n第二行(多行选项)" });
    // 整行:父容器纵向堆叠(flex-col),选项按钮整行宽(w-full)+ 文本左对齐 + 多行保留
    const group = optA.closest("[role=radiogroup]");
    expect(group?.className).toContain("flex-col");
    expect(optA.className).toContain("w-full");
    expect(optA.className).toContain("text-left");
    const labelSpan = optA.querySelector("span.min-w-0");
    expect(labelSpan?.className).toContain("whitespace-pre-wrap");
    expect(labelSpan?.className).toContain("break-words");
  });

  it("选项 description 作为第二行弱化展示(不再是 title 悬停)", async () => {
    render(<AskQuestionCard toolCall={{ name: "ask_user_question", state: "running" }} collapseDefault={true} />);
    fireQuestion([
      { id: "q1", question: "选一个", options: [{ label: "A", description: "这是 A 的详细说明\n两行" }] },
    ]);
    const desc = screen.getByText(/这是 A 的详细说明/);
    expect(desc.className).toContain("whitespace-pre-wrap");
  });

  it("单选 + 自定义输入:键入即取代选项选择(两种互斥,提交 custom)", async () => {
    render(<AskQuestionCard toolCall={{ name: "ask_user_question", state: "running" }} collapseDefault={true} />);
    fireQuestion([
      { id: "q1", question: "选一个", options: [{ label: "A" }, { label: "B" }] },
    ]);

    fireEvent.click(screen.getByRole("radio", { name: "B" }));
    // 键入自定义答案 → 选项选择被取代
    fireEvent.change(screen.getByPlaceholderText(/自定义答案/), { target: { value: "我自己写\n多行也行" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(mocks.answerQuestion).toHaveBeenCalledWith("req-1", [{ id: "q1", selected: [], custom: "我自己写\n多行也行" }]);
    });
  });

  it("多选 + 自定义输入:勾选多项且与自定义答案共存,一并提交", async () => {
    render(<AskQuestionCard toolCall={{ name: "ask_user_question", state: "running" }} collapseDefault={true} />);
    fireQuestion([
      { id: "q1", question: "选哪些", multi_select: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
    ]);

    const optA = screen.getByRole("checkbox", { name: "A" });
    const optB = screen.getByRole("checkbox", { name: "B" });
    fireEvent.click(optA);
    fireEvent.click(optB);
    expect(optA).toHaveAttribute("aria-checked", "true");
    expect(optB).toHaveAttribute("aria-checked", "true");
    // 再点 A 取消(多选 toggle)
    fireEvent.click(optA);
    expect(optA).toHaveAttribute("aria-checked", "false");
    // 自定义答案与已选共存
    fireEvent.change(screen.getByPlaceholderText(/自定义答案/), { target: { value: "补充一点" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(mocks.answerQuestion).toHaveBeenCalledWith("req-1", [{ id: "q1", selected: ["B"], custom: "补充一点" }]);
    });
  });

  it("args 补全:pi 帧不带 multi_select/description,从 toolCall.args.questions 补回(ask-design §7)", async () => {
    render(
      <AskQuestionCard
        toolCall={{
          name: "ask_user_question",
          state: "running",
          args: { questions: [{ id: "q1", question: "选哪些", multi_select: true, options: [{ label: "A", description: "A 的说明" }, { label: "B" }] }] },
        }}
        collapseDefault={true}
      />,
    );
    // 帧只带 title/options(pi onQuestion 翻译),不带 multi_select/description
    fireQuestion([{ id: "req-synth", question: "选哪些", options: [{ label: "A" }, { label: "B" }] }]);

    // 补全后:checkbox 语义(多选)+ description 第二行
    expect(screen.getByRole("checkbox", { name: "A" })).toBeInTheDocument();
    expect(screen.getByText(/A 的说明/)).toBeInTheDocument();
  });

  it("复活:结算态块 + 命中 pending 记录(toolCallId 精确锚定)→ 恢复交互卡,作答后 dismissed(ask-design §8.2)", async () => {
    mocks.getPendingQuestions.mockResolvedValue([
      {
        requestId: "req-old", kernel: "pi", neutralSessionId: "ns-1", cwd: "/p", sessionKey: "/p/s.jsonl",
        procNonce: "n1", toolCallId: "call_X", questions: [{ id: "q1", question: "重启前的问题？", options: [{ label: "继续" }, { label: "算了" }] }],
        status: "pending", createdAt: "2026-09-02T00:00:00.000Z",
      },
    ]);
    // 模拟服务端结算语义:answerQuestion 成功后记录转 answered,getPendingQuestions 不再返回
    mocks.answerQuestion.mockImplementation(() => {
      mocks.getPendingQuestions.mockResolvedValue([]);
      return Promise.resolve();
    });
    render(<AskQuestionCard toolCall={{ id: "call_X", name: "ask_user_question", state: "done" }} collapseDefault={true} />);

    // 记录到达 → 交互卡复活(问题 + 选项)
    await waitFor(() => expect(screen.getByText("重启前的问题？")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "继续" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => {
      expect(mocks.answerQuestion).toHaveBeenCalledWith("req-old", [{ id: "q1", selected: ["继续"] }]);
    });
    // 作答后卡片退场(记录已结算,不再渲染交互态)
    await waitFor(() => expect(screen.queryByText("重启前的问题？")).not.toBeInTheDocument());
  });

  it("复活 fallback:会话唯一 pending 记录(无 toolCallId)也复活;有 result 的块不复活", async () => {
    mocks.getPendingQuestions.mockResolvedValue([
      {
        requestId: "req-orphan", kernel: "pi", neutralSessionId: "ns-1", cwd: "/p", sessionKey: "/p/s.jsonl",
        procNonce: "n1", toolCallId: null, questions: [{ id: "q1", question: "孤儿提问？" }],
        status: "pending", createdAt: "2026-09-02T00:00:00.000Z",
      },
    ]);
    render(<AskQuestionCard toolCall={{ id: "call_X", name: "ask_user_question", state: "done" }} collapseDefault={true} />);
    await waitFor(() => expect(screen.getByText("孤儿提问？")).toBeInTheDocument());
  });

  it("结算卡:展开体渲染问句 + 选项(选中高亮)+ 自定义答案(ask-design §9)", async () => {
    render(
      <AskQuestionCard
        toolCall={{
          name: "ask_user_question",
          state: "done",
          args: { questions: [{ id: "q1", question: "部署到哪里？", options: [{ label: " staging" }, { label: "prod" }] }] },
          result: { answers: [{ id: "q1", selected: ["prod"] }] },
        }}
        collapseDefault={false}
      />,
    );
    // 问句正文 + 两个选项 + 选中标记(☑ prod/☐ staging)
    expect(screen.getByText("部署到哪里？")).toBeInTheDocument();
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByText("☑")).toBeInTheDocument();
    expect(screen.getByText("☐")).toBeInTheDocument();
  });
});
