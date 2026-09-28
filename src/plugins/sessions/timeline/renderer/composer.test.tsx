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

  it("命令生效高亮:输入以已注册命令名整词开头 → 药丸挂类 + chip;参数输入后高亮仍在(§7.2)", () => {
    const { container } = render(
      <Composer value="/goal 写 README" onValueChange={() => {}} onSubmit={() => {}} commands={commands} />,
    );
    const pill = container.querySelector("[data-command-active]");
    expect(pill).not.toBeNull();
    expect(pill!.classList.contains("shell-composer-command")).toBe(true);
    // chip 显示命令名 + 来源徽标
    const chip = container.querySelector("[data-command-chip]");
    expect(chip?.textContent).toContain("/goal");
    expect(chip?.textContent).toContain("cmd"); // plugin 来源徽标
  });

  it("不命中不高亮:未注册命令名/非命令输入/空输入都无 chip 无类", () => {
    for (const v of ["/unknown x", "普通消息", "", "/goalx 假命令"]) {
      const { container, unmount } = render(
        <Composer value={v} onValueChange={() => {}} onSubmit={() => {}} commands={commands} />,
      );
      expect(container.querySelector("[data-command-active]")).toBeNull();
      expect(container.querySelector("[data-command-chip]")).toBeNull();
      unmount();
    }
  });
});

describe("Composer 发送拦截接线(与 timeline sendText 同款顺序)", () => {
  const handledInputs: string[] = [];

  beforeEach(() => {
    handledInputs.length = 0;
    registerComposerCommands([
      {
        name: "goal",
        descriptionKey: "test.command.desc",
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

  it("发送在飞(sending=true)时敲命令回车 → 仍提交(命令不被发送闸吃掉)", async () => {
    // 根因回归守卫:发送 RPC 在飞窗口(sending=true)里 canSend=false,旧代码 Enter 整吞
    // 命令——输入框清了但 handle 没跑(goal 会话里 /goal stop 停不掉续跑)。
    // 命令永不进内核消息流(sendText 先拦截),不该被「发送在飞」闸挡。
    const onSubmit = vi.fn();
    render(<Composer value="/goal stop" onValueChange={() => {}} onSubmit={onSubmit} sending commands={[{ name: "goal", description: "x", source: "plugin" } as never]} />);
    const textarea = document.querySelector("textarea")!;
    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter" }); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("发送在飞 + 普通消息回车 → 仍不提交(防重复发送的门不变)", async () => {
    const onSubmit = vi.fn();
    render(<Composer value="普通消息" onValueChange={() => {}} onSubmit={onSubmit} sending />);
    const textarea = document.querySelector("textarea")!;
    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter" }); });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("Composer goal 生效着色(输入框上方目标条的呼应面)", () => {
  it("goalActive=true → 药丸挂 shell-composer-goal 类 + data-goal-active 锚点", () => {
    render(<Composer value="" onValueChange={() => {}} onSubmit={() => {}} goalActive />);
    const textarea = document.querySelector("[data-timeline-composer]")!;
    const pill = textarea.parentElement!; // 药丸容器
    expect(pill.classList.contains("shell-composer-goal")).toBe(true);
    expect(pill.getAttribute("data-goal-active")).toBe("true");
  });

  it("goalActive 缺省 → 无目标着色,保持常态边框", () => {
    render(<Composer value="" onValueChange={() => {}} onSubmit={() => {}} />);
    const textarea = document.querySelector("[data-timeline-composer]")!;
    const pill = textarea.parentElement!;
    expect(pill.classList.contains("shell-composer-goal")).toBe(false);
    expect(pill.getAttribute("data-goal-active")).toBeNull();
  });
});

describe("Composer 思考开关的显式降级(§7.6:dsh 无运行时切档面)", () => {
  // 中段渲染门槛是 models/levels 任一非空(hasMiddle);dsh 会话 models 非空、levels 空。
  const dshModels = [{ kernel: "dsh" as const, provider: "us-new", id: "m1", name: "m1", contextWindow: 128000, maxTokens: 8192 }];

  it("后端无切档面(dsh):思考开关置灰 + 悬浮诚实原因,不挂「思考已关闭」误导文案", () => {
    render(
      <Composer
        value="" onValueChange={() => {}} onSubmit={() => {}}
        models={dshModels} levels={[]} onPickLevel={() => {}}
        thinkingUnavailableHint="当前内核不支持运行时切换思考深度"
      />,
    );
    // 置灰开关的 title = 诚实原因(显式降级),而不是 on/off 语义文案
    const btn = screen.getByTitle("当前内核不支持运行时切换思考深度");
    expect(btn).toBeDisabled();
    expect(screen.queryByTitle("shell.thinkingOff")).not.toBeInTheDocument();
  });

  it("后端有切档面(pi):不传 hint,保持「思考已开启/已关闭」语义(回归位)", () => {
    render(
      <Composer
        value="" onValueChange={() => {}} onSubmit={() => {}}
        models={dshModels} levels={["off", "high"]} currentLevel="high" onPickLevel={() => {}}
      />,
    );
    expect(screen.getByTitle("shell.thinkingOn")).toBeInTheDocument();
  });
});
