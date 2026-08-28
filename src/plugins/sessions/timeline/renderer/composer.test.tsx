// @vitest-environment jsdom
// Composer DOM e2e —— 真实 Composer 渲染 + 真实键入,覆盖用户 /goal 命令的发送链路前半段:
// ① 斜杠弹窗合并壳插件命令(source=plugin,徽标 cmd)并可插入;
// ② 发送拦截接线(与 timeline sendText 同款顺序):命中命令 → 吞掉发送 + 清输入框,未命中 → 照发。
// 命令 handle 的执行面(设置/删改停)在 goal 插件自己的 DOM e2e(goal-bar.test.tsx)全链路覆盖。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@my-harness-desktop/react", async () => {
  // composer.tsx 只用到 PluginIcon(模型清单用,本测试不传 models)+ 类型;
  // 注册表机制用真实实现(vitest alias 指向 packages/react 源码)。
  const actual = await vi.importActual<typeof import("@my-harness-desktop/react")>("@my-harness-desktop/react");
  return {
    ...actual,
    PluginIcon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh-CN" } }),
}));

import { Composer } from "./composer";
import { registerComposerCommands, unregisterComposerCommands, runComposerCommandIfMatch } from "@my-harness-desktop/react";
import type { CommandItem } from "@my-harness-desktop/shared";

describe("Composer 斜杠弹窗(含壳插件命令)", () => {
  const commands: CommandItem[] = [
    { name: "compact", source: "skill", description: "压缩上下文" },
    { name: "goal", source: "plugin", description: "设置/管理目标" },
  ];

  it("键入 / → 弹窗同时列出内核命令与插件命令;插件命令挂 cmd 徽标", () => {
    render(
      <Composer value="/" onValueChange={() => {}} onSubmit={() => {}} commands={commands} />,
    );
    expect(screen.getByText("/compact")).toBeInTheDocument();
    expect(screen.getByText("/goal")).toBeInTheDocument();
    // source=plugin 渲染成 cmd 徽标(与 skill/ext/prompt 并列的第四种来源)
    expect(screen.getByText("cmd")).toBeInTheDocument();
    expect(screen.getByText("skill")).toBeInTheDocument();
  });

  it("键入 /go 过滤命中插件命令,Enter 插入 /goal 进输入框", () => {
    const onValueChange = vi.fn();
    render(
      <Composer value="/go" onValueChange={onValueChange} onSubmit={() => {}} commands={commands} />,
    );
    const textarea = document.querySelector("textarea")!;
    // /go 前缀过滤后只剩 goal
    expect(screen.getByText("/goal")).toBeInTheDocument();
    expect(screen.queryByText("/compact")).not.toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: "Enter" });
    // 插入命令而非提交:onChange 收到 "/goal"
    expect(onValueChange).toHaveBeenCalledWith("/goal");
  });
});

describe("Composer 发送拦截接线(与 timeline sendText 同款顺序)", () => {
  const handledInputs: string[] = [];

  beforeEach(() => {
    handledInputs.length = 0;
    registerComposerCommands([
      {
        name: "goal",
        description: "测试命令",
        handle: (input) => { handledInputs.push(input); return true; },
      },
    ]);
  });

  afterEach(() => {
    unregisterComposerCommands(["goal"]);
  });

  /** 最小发送外壳:复刻 timeline sendText 的拦截顺序(命令判定先于发送)。 */
  function SendHarness(): React.ReactNode {
    const [input, setInput] = useState("");
    const onSubmit = async (): Promise<void> => {
      const trimmed = input.trim();
      if (trimmed.startsWith("/")) {
        const handled = await runComposerCommandIfMatch(trimmed);
        if (handled) { setInput(""); return; }
      }
      // 未拦截 = 走真实发送(此处以 data-sent 标记代替)
      document.body.setAttribute("data-sent", trimmed);
      setInput("");
    };
    return <Composer value={input} onValueChange={setInput} onSubmit={onSubmit} />;
  }

  it("键入 /goal <目标> 回车 → 命令被处理、不发送、输入框清空", async () => {
    render(<SendHarness />);
    const textarea = document.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/goal 写 README" } });
    // 异步 act:flush onSubmit 里 await 的命令处理
    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter" }); });

    expect(handledInputs).toEqual(["/goal 写 README"]); // 命令收到全文
    expect(textarea.value).toBe(""); // 输入框已清
    expect(document.body.getAttribute("data-sent")).toBeNull(); // 未走发送
  });

  it("普通消息回车 → 不拦截、照常发送", async () => {
    render(<SendHarness />);
    const textarea = document.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "帮我写个函数" } });
    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter" }); });

    expect(handledInputs).toEqual([]);
    expect(document.body.getAttribute("data-sent")).toBe("帮我写个函数");
    document.body.removeAttribute("data-sent");
  });

  it("未注册的 /cmd 回车 → 放行(兼容内核斜杠命令,如 /compact)", async () => {
    render(<SendHarness />);
    const textarea = document.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/compact" } });
    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter" }); });

    expect(handledInputs).toEqual([]);
    expect(document.body.getAttribute("data-sent")).toBe("/compact");
    document.body.removeAttribute("data-sent");
  });
});
