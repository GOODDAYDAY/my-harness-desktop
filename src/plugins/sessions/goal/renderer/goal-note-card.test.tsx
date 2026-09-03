// @vitest-environment jsdom
// goal 控制动作留痕卡 DOM 测试:中立层注解(机读 JSON)→ GoalNoteCard 按当前语言渲染;
// 畸形内容不炸时间线(返回 null)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => {
  const dict: Record<string, string> = {
    "note.pause": "已暂停目标续跑",
    "note.resume": "已恢复目标续跑",
    "note.edit": "已修改目标：{{detail}}",
    "note.limit": "轮数上限改为 {{detail}}",
    "note.clear": "已删除目标",
    "note.auto_pause_error": "回合异常结束，目标已自动暂停",
    "note.auto_pause_interrupt": "回合被中断，目标已自动暂停",
    "note.send_failed": "续跑发送失败，目标已自动暂停：{{detail}}",
  };
  const t = (k: string, vars?: Record<string, unknown>): string => {
    const bare = k.startsWith("goal.") ? k.slice(5) : k;
    return (dict[bare] ?? k).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars?.[name] ?? ""));
  };
  return { useTranslation: () => ({ t, i18n: { language: "zh-CN" } }) };
});

import { GoalNoteCard, parseGoalNote } from "./goal-note-card";
import type { NeutralMessage } from "@my-harness-desktop/shared";

function card(content: string): void {
  render(<GoalNoteCard message={{ role: "goal_note", content } as NeutralMessage} streaming={false} />);
}

describe("parseGoalNote(注解内容解析)", () => {
  it("合法 JSON 解出 action + detail", () => {
    expect(parseGoalNote('{"action":"limit","detail":"500"}')).toEqual({ action: "limit", detail: "500" });
    expect(parseGoalNote('{"action":"pause"}')).toEqual({ action: "pause" });
  });

  it("畸形/未知动作/非字符串 → null(不炸时间线)", () => {
    expect(parseGoalNote("not json")).toBeNull();
    expect(parseGoalNote('{"action":"unknown_action"}')).toBeNull();
    expect(parseGoalNote('{"x":1}')).toBeNull();
    expect(parseGoalNote(42)).toBeNull();
  });
});

describe("GoalNoteCard(控制动作留痕卡)", () => {
  it("渲染本地化动作文案 + 锚点", () => {
    card('{"action":"pause"}');
    expect(screen.getByText("已暂停目标续跑")).toBeInTheDocument();
    expect(document.querySelector("[data-goal-note]")).not.toBeNull();
  });

  it("detail 参数进文案(改上限)", () => {
    card('{"action":"limit","detail":"500"}');
    expect(screen.getByText("轮数上限改为 500")).toBeInTheDocument();
  });

  it("畸形内容不渲染(静默跳过)", () => {
    const { container } = render(
      <GoalNoteCard message={{ role: "goal_note", content: "坏的" } as NeutralMessage} streaming={false} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
