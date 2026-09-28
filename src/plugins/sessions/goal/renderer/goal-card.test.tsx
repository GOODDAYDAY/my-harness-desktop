// @vitest-environment jsdom
// GoalCard 的可折叠头语义与执行状态文案（r52）。
//
// 为什么这一组断言值得单独立文件：GoalCard 与 message-blocks 的 `CardHeader` 是
// **两份近乎相同的可折叠头实现**（图标 + 摘要 + 状态 + chevron + 可折叠正文）。
// r41 修 CardHeader 时补齐了 `aria-expanded` 与状态文案的 i18n/可访问名，
// 而这一份**漂移着留到现在**——`running` 仍是硬编码英文、成功/失败仍是纯图标
// （`<Check/>` / `<X/>`，无可访问名）、且没有 `aria-expanded`。
// 这正是 §3.5「重复实现」的典型代价：**修一处漏一处**，而且漏掉的那处不会报错。
//
// 本文件钉住三件事：折叠三件套齐全、状态有文本语义、文案走 i18n 而非硬编码英文。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallBlock } from "@my-harness-desktop/react";
import { GoalCard } from "./goal-card";

// 真字典（不在测试里另抄一份——另抄必然漂移）。状态词住在 **system/i18n 的 shell.json**
// （r52 从 message-blocks 挪过去，因为 goal 与 message-blocks 共用同一组词，
// 而跨插件依赖另一个**业务**插件的语言包是脆的：用户禁用 message-blocks 就丢文案）。
const __here = dirname(fileURLToPath(import.meta.url));
const DICT: Record<string, string> = JSON.parse(
  readFileSync(join(__here, "../../../system/i18n/locales/zh-CN/shell.json"), "utf-8"),
) as Record<string, string>;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>): string => {
      let v = DICT[k] ?? k;
      for (const [n, val] of Object.entries(vars ?? {})) v = v.split(`{{${n}}}`).join(String(val));
      return v;
    },
    i18n: { exists: (k: string) => k in DICT },
  }),
}));

const running = { state: "running", name: "goal_round", input: {}, id: "g1" } as unknown as ToolCallBlock;
const done = { state: "completed", name: "goal_round", input: {}, id: "g1", result: "ok" } as unknown as ToolCallBlock;

describe("GoalCard 折叠头：语义三件套齐全（r41 定的纪律）", () => {
  it("role=button + tabIndex=0 + Enter/Space 键处理 + aria-expanded 同时在场", () => {
    const { container } = render(<GoalCard toolCall={done} />);
    const head = container.querySelector('[role="button"]')!;
    expect(head, "折叠头必须是 button 语义（否则读屏不知道它可操作）").toBeTruthy();
    expect(head.getAttribute("tabindex"), "必须能 Tab 到").toBe("0");
    const before = head.getAttribute("aria-expanded");
    expect(before === "true" || before === "false", `aria-expanded 必须是布尔字面量（实际 ${before}）`).toBe(true);
    fireEvent.keyDown(head, { key: "Enter" });
    expect(head.getAttribute("aria-expanded"), "Enter 后必须翻转（否则读屏用户展开了却听不到）").not.toBe(before);
    fireEvent.keyDown(head, { key: " " });
    expect(head.getAttribute("aria-expanded"), "空格键同样能切回").toBe(before);
  });
});

describe("GoalCard 执行状态：要有文本语义，文案走 i18n", () => {
  it("运行中显示**译文**而不是硬编码英文 running", () => {
    const { container } = render(<GoalCard toolCall={running} />);
    const txt = container.textContent ?? "";
    expect(txt, "硬编码的英文 running 不该再出现（zh-CN 字典下应是中文）").not.toMatch(/(^|[^\w])running([^\w]|$)/);
    expect(txt).toContain(DICT["shell.toolRunning"]);
    expect(DICT["shell.toolRunning"], "字典里必须有这个键（否则 t() 回落到 key，界面会显示 shell.toolRunning）").toBeTruthy();
  });

  it("完成态：成功/失败由 **sr-only 文本**承担语义，图标只作视觉锚（aria-hidden）", () => {
    const { container } = render(<GoalCard toolCall={done} />);
    const ok = container.querySelector('[data-exec-status="success"]');
    const err = container.querySelector('[data-exec-status="error"]');
    expect(ok && err, "同一张卡不能同时标成功与失败").toBeFalsy();
    const node = (ok ?? err)!;
    expect(node, "完成的卡应有状态节点").toBeTruthy();
    expect(node.querySelector("svg")?.getAttribute("aria-hidden"), "图标是装饰，语义应由文本承担").not.toBeNull();
    const srText = node.querySelector(".sr-only")?.textContent ?? "";
    expect(srText, "状态必须有可被读屏读到的文本（纯图标 = 读屏用户不知道成功还是失败）").toBeTruthy();
    expect(srText).toBe(ok ? DICT["shell.toolSucceeded"] : DICT["shell.toolFailed"]);
    expect(srText).not.toContain("shell.");
  });
});
