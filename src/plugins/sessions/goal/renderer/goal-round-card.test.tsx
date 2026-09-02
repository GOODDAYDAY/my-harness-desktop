// @vitest-environment jsdom
// goal 续跑卡 DOM e2e:<goal_round> 包装的用户消息 → auxParser 剥块 → 目标续跑卡呈现
// (所见即所得的另一半:加了包装就换种方式展示,不冒充用户气泡)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { goalRoundParser, parseGoalRoundData } from "./goal-round-parser";
import { renderContinuationPrompt } from "./goal-reduce";

vi.mock("react-i18next", () => {
  const dict: Record<string, string> = {
    "roundCard.title": "目标续跑",
    "roundCard.roundOf": "第 {{round}}/{{max}} 轮",
  };
  const t = (k: string, vars?: Record<string, unknown>): string => {
    const bare = k.startsWith("goal.") ? k.slice(5) : k;
    return (dict[bare] ?? k).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars?.[name] ?? ""));
  };
  return { useTranslation: () => ({ t, i18n: { language: "zh-CN" } }) };
});

import { GoalRoundCard } from "./goal-round-card";

describe("goalRoundParser(<goal_round> 剥块)", () => {
  it("完整包装 → standalone 块,objective/round/maxRounds 齐", () => {
    const text = renderContinuationPrompt("把测试全跑绿", 3, 8);
    const r = goalRoundParser.parse(text);
    expect(r?.blocks).toHaveLength(1);
    const b = r!.blocks[0];
    expect(b.type).toBe("goal_round");
    expect(b.standalone).toBe(true);
    expect(b.start).toBe(0);
    expect(b.end).toBe(text.length);
    const data = b.data as { objective: string; round: number; maxRounds: number };
    expect(data.objective).toBe("把测试全跑绿");
    expect(data.round).toBe(3);
    expect(data.maxRounds).toBe(8);
  });

  it("objective 含特殊字符(JSON 转义)也能解回原文", () => {
    const data = parseGoalRoundData(renderContinuationPrompt('带"引号"和\n换行的目标', 1, 256));
    expect(data.objective).toBe('带"引号"和\n换行的目标');
  });

  it("普通用户文本不命中(不误剥)", () => {
    expect(goalRoundParser.parse("今天天气怎么样")).toBeNull();
    expect(goalRoundParser.parse("/goal 让ping三轮")).toBeNull();
  });

  it("畸形包装(缺字段)不炸:字段为 null/空,块仍在", () => {
    const r = goalRoundParser.parse("<goal_round>随便写的</goal_round>");
    expect(r?.blocks).toHaveLength(1);
    const data = r!.blocks[0].data as { objective: string; round: number | null };
    expect(data.objective).toBe("");
    expect(data.round).toBeNull();
  });
});

describe("GoalRoundCard(目标续跑卡 DOM)", () => {
  function card(raw: string): HTMLElement {
    const r = goalRoundParser.parse(raw)!;
    const { container } = render(<GoalRoundCard aux={r.blocks[0]} />);
    return container as unknown as HTMLElement;
  }

  it("默认紧凑卡:标题 + 轮次 + 目标摘要,不展开原文", () => {
    const el = card(renderContinuationPrompt("把测试全跑绿", 3, 256));
    expect(el.querySelector("[data-goal-round-card]")).not.toBeNull();
    expect(screen.getByText("目标续跑")).toBeInTheDocument();
    expect(screen.getByText("第 3/256 轮")).toBeInTheDocument();
    expect(screen.getByText("把测试全跑绿")).toBeInTheDocument();
    // 原文(英文指令)默认不展示
    expect(el.textContent).not.toContain("Continue working toward");
  });

  it("点击展开/收起包装原文(用户有权看到模型实际收到了什么)", () => {
    const el = card(renderContinuationPrompt("x", 1, 256));
    fireEvent.click(screen.getByRole("button"));
    expect(el.textContent).toContain("Continue working toward");
    fireEvent.click(screen.getByRole("button"));
    expect(el.textContent).not.toContain("Continue working toward");
  });
});
