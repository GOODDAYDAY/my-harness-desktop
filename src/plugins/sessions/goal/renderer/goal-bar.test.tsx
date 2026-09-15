// @vitest-environment jsdom
// GoalBar DOM e2e —— 真实渲染 + 真实 DOM 交互,覆盖用户视角的完整闭环:
// 人敲 /goal 设置(经 composerCommands 机制入口 runGoalCommand)→ 目标条出现 →
// 点按钮停止/恢复/编辑/关闭(删改停全可见——编辑是显式铅笔按钮,不再伪装成轮次数字)→
// 状态与续跑副作用逐条对账。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { SessionEvent } from "@my-harness-desktop/shared";

// i18n:测试用真实 zh-CN 字典(DOM 断言跑真文案,不断言 key)。
// 与生产同形状:第一个 dot 前是 ns(goal),剩余是嵌套 key;{{var}} 插值。
vi.mock("react-i18next", () => {
  const dict: Record<string, string> = {
    "bar.pause": "停止",
    "bar.resume": "恢复",
    "bar.edit": "编辑目标",
    "bar.clear": "关闭目标",
    "bar.save": "保存",
    "bar.achieved": "目标已完成",
    "roundCard.title": "目标续跑",
    "roundCard.roundOf": "第 {{round}}/{{max}} 轮",
    "roundCard.toggle": "展开/收起续跑提示原文",
  };
  const t = (k: string, vars?: Record<string, unknown>): string => {
    const bare = k.startsWith("goal.") ? k.slice(5) : k;
    const tpl = dict[bare] ?? k;
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars?.[name] ?? ""));
  };
  return { useTranslation: () => ({ t, i18n: { language: "zh-CN" } }) };
});

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  updateHeader: vi.fn(),
  annotate: vi.fn(),
  openSession: vi.fn(),
  notify: vi.fn(),
  eventsEmit: vi.fn(),
  onEventCb: null as ((e: SessionEvent) => void) | null,
}));

// mock 边界(设计 session-scope.md 批 4 迁移后收紧):**只 mock usePluginContext**(IPC/内核边界)。
// useUiStore / useSessionStore / 会话作用域 hook 全部走真实实现——mock 掉作用域就测不出
// 「A 会话的目标条不出现在 B 会话」这个迁移的核心目的(等同地位、等同功能,不做假实现)。
vi.mock("@my-harness-desktop/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@my-harness-desktop/react")>();
  const sessions = {
    onEvent: (cb: (e: SessionEvent) => void) => {
      mocks.onEventCb = cb;
      return () => { mocks.onEventCb = null; };
    },
    onKernelEvent: () => () => {},
    updateHeader: mocks.updateHeader,
    openSession: mocks.openSession,
    annotate: mocks.annotate,
  };
  return {
    ...actual,   // 作用域 hook / useUiStore / useSessionStore / hasPendingUserSend 全部真跑
    usePluginContext: () => ({
      sessions,
      messaging: { prompt: mocks.prompt },
      notify: { show: mocks.notify },
      events: { emit: mocks.eventsEmit, on: vi.fn(() => () => {}) },
    }),
  };
});

import { GoalBar } from "./goal-bar";
import { runGoalCommand } from "./goal-controller";
import { useUiStore, useSessionStore, clearQueue } from "@my-harness-desktop/react";
import { __resetScopesForTests } from "@my-harness-desktop/react";
import { GoalPluginWrapper } from "./test-harness";

// test-harness import 即完成注册(真实槽声明 + 绑好 pluginId 的 wrapper);不 mock 作用域容器。

/** 切会话(生产路径同款:写 ui-store 身份字段,scopeKey 随之变,GoalBar 自动换档)。 */
function switchSession(ns: string | null, path: string | null): void {
  act(() => {
    useUiStore.setState({ currentNeutralSessionId: ns, currentSessionPath: path });
  });
}

function emit(e: SessionEvent): void {
  act(() => { mocks.onEventCb?.(e); });
}

describe("GoalBar DOM e2e(设置 + 删改停)", () => {
  beforeEach(() => {
    mocks.prompt.mockReset();
    mocks.prompt.mockResolvedValue(undefined);
    mocks.updateHeader.mockReset();
    mocks.updateHeader.mockResolvedValue(undefined);
    mocks.annotate.mockReset();
    mocks.annotate.mockResolvedValue(undefined);
    mocks.openSession.mockReset();
    mocks.openSession.mockResolvedValue(null);
    mocks.notify.mockReset();
    mocks.notify.mockResolvedValue(undefined);
    mocks.eventsEmit.mockReset();
    mocks.onEventCb = null;
    // 真实 store 复位:作用域容器清空 + 身份指向会话 A + 消息历史/配置清空 + 队列清空
    __resetScopesForTests();
    useUiStore.setState({ currentNeutralSessionId: "ns-a", currentSessionPath: "/p/ns-a.jsonl", currentCwd: "/p", generalConfig: {} });
    useSessionStore.setState({ messages: [], sessionInfos: null });
    clearQueue();
  });

  it("无目标不渲染;人敲 /goal → 目标落状态 + 返回 {send:目标正文} 交 timeline 真发(所见即所得)", async () => {
    const { container } = render(<GoalBar />, { wrapper: GoalPluginWrapper });
    expect(container.firstChild).toBeNull();

    // composerCommands 机制入口:与 timeline 发送拦截调用的是同一个函数
    await act(async () => {
      const handled = await runGoalCommand("/goal 把 e2e 测试补齐");
      // 所见即所得:不再吞掉发送,返回改写结果——目标正文由 timeline 作为真实用户消息发出
      expect(handled).toEqual({ send: "把 e2e 测试补齐" });
    });

    expect(screen.getByText("把 e2e 测试补齐")).toBeInTheDocument();
    // set 不装弹:kickoff 消息(目标正文)本身就是第 0 轮,它的收敛自然接第 1 轮
    expect(screen.getByText("0/1000")).toBeInTheDocument();
    expect(mocks.prompt).toHaveBeenCalledTimes(0);
    // active 态视觉:成功色左边框 + 停止按钮在位(内联样式含 var() 原样断言,不依赖 jsdom 解析变量)
    expect(container.firstElementChild?.getAttribute("style")).toContain("var(--color-accent-success)");
    expect(screen.getByTitle("停止")).toBeInTheDocument();
    // 横幅身份锚点(e2e 定位用)+ 相位数据属性
    expect(container.querySelector("[data-goal-bar]")).not.toBeNull();
    expect(container.querySelector('[data-goal-phase="active"]')).not.toBeNull();

    // kickoff 回合收敛 → 第 1 轮续跑
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1/1000")).toBeInTheDocument();
  });

  it("停止(删改停之「停」):点按钮 → paused 态,回合收敛不再续跑", async () => {
    const { container } = render(<GoalBar />, { wrapper: GoalPluginWrapper });
    await act(async () => { await runGoalCommand("/goal 停下来的目标"); });

    // DOM 点击停止
    fireEvent.click(screen.getByTitle("停止"));

    expect(screen.getByTitle("恢复")).toBeInTheDocument(); // 按钮翻转为恢复
    // paused 态视觉:警告色左边框(active 时是成功色)
    expect(container.firstElementChild?.getAttribute("style")).toContain("var(--color-accent-warning)");
    expect(container.querySelector('[data-goal-phase="paused"]')).not.toBeNull();
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(0); // 暂停不续跑
  });

  it("恢复:点按钮 → 立即补发一轮续跑(DOM 上见新轮次)", async () => {
    render(<GoalBar />, { wrapper: GoalPluginWrapper });
    await act(async () => { await runGoalCommand("/goal 恢复测试"); });

    fireEvent.click(screen.getByTitle("停止"));
    expect(screen.getByTitle("恢复")).toBeInTheDocument();

    // DOM 点击恢复:空闲即装弹,不用等下一次回合收敛
    await act(async () => { fireEvent.click(screen.getByTitle("恢复")); });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 恢复轮
    expect(screen.getByText("1/1000")).toBeInTheDocument();
  });

  it("编辑(删改停之「改」):点铅笔按钮 → 出现输入框 → 键入新目标回车 → 下次续跑用新目标", async () => {
    render(<GoalBar />, { wrapper: GoalPluginWrapper });
    await act(async () => { await runGoalCommand("/goal 旧目标"); });

    // DOM 点击铅笔(显式编辑入口;此前伪装成轮次数字按钮,不可发现——用户要求 #6)
    fireEvent.click(screen.getByTitle("编辑目标"));
    const input = screen.getByPlaceholderText("旧目标");
    expect(input).toBeInTheDocument();

    // 键入新目标 + 回车提交
    fireEvent.change(input, { target: { value: "改过的新目标" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("改过的新目标")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("旧目标")).not.toBeInTheDocument();

    // 下次续跑提示用新目标
    emit({ type: "agentSettled" });
    const last = mocks.prompt.mock.calls[mocks.prompt.mock.calls.length - 1][0];
    expect(last).toContain("改过的新目标");
  });

  it("编辑:Escape 取消,目标不变", async () => {
    render(<GoalBar />, { wrapper: GoalPluginWrapper });
    await act(async () => { await runGoalCommand("/goal 不改动目标"); });

    fireEvent.click(screen.getByTitle("编辑目标"));
    const input = screen.getByPlaceholderText("不改动目标");
    fireEvent.change(input, { target: { value: "白打一场" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.getByText("不改动目标")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("白打一场")).not.toBeInTheDocument();
  });

  it("关闭(删改停之「删」):点垃圾桶 → 目标条从 DOM 消失 + 头行落 null 删键", async () => {
    const { container } = render(<GoalBar />, { wrapper: GoalPluginWrapper });
    await act(async () => { await runGoalCommand("/goal 待删除目标"); });
    expect(container.firstElementChild).not.toBeNull();

    fireEvent.click(screen.getByTitle("关闭目标"));

    expect(container.firstChild).toBeNull(); // DOM 消失
    expect(mocks.updateHeader).toHaveBeenLastCalledWith("/p/ns-a.jsonl", { custom: { goal: null } });

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(0); // 关闭后不再续跑
  });

  it("完成态(achieved):展示「目标已完成」,不再有停/恢复/编辑入口,只剩关闭", async () => {
    render(<GoalBar />, { wrapper: GoalPluginWrapper });
    // 模型调 set_goal 再 achieve_goal → achieved
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "三轮 ping" } });
    emit({ type: "toolCallStart", toolName: "achieve_goal" });

    expect(screen.getByText("目标已完成")).toBeInTheDocument(); // 完成标记展示(用户要求 #4 扩展)
    expect(screen.getByText("三轮 ping")).toBeInTheDocument(); // 目标原文还在
    // 完成态:停/恢复/编辑入口全部撤离(完成的目标没有这些语义),只剩关闭
    expect(screen.queryByTitle("停止")).not.toBeInTheDocument();
    expect(screen.queryByTitle("恢复")).not.toBeInTheDocument();
    expect(screen.queryByTitle("编辑目标")).not.toBeInTheDocument();
    expect(screen.getByTitle("关闭目标")).toBeInTheDocument();

    // 关闭后横幅消失
    fireEvent.click(screen.getByTitle("关闭目标"));
    expect(screen.queryByText("三轮 ping")).not.toBeInTheDocument();
  });

  // ── 会话作用域迁移的核心目的(设计 docs/design/session-scope.md §5.2)──────────────
  // 迁移前这四个断言全部不成立:goal 态是模块级单例,切会话靠异步 effect + 字符串比对补换档,
  // 于是「A 的目标条挂在 B 会话上」「B 的 agentSettled 驱动 A 的目标烧轮次」(设计 §1.3.3)。
  it("切会话换档:A 的目标条不出现在 B 会话(串台守卫)", () => {
    const { container } = render(<GoalBar />, { wrapper: GoalPluginWrapper });
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "A 会话的目标" } });
    expect(screen.getByText("A 会话的目标")).toBeInTheDocument();
    expect(container.querySelector('[data-goal-phase="active"]')).not.toBeNull();

    // 切到 B 会话(生产路径同款:写 ui-store 身份字段)——目标条必须消失
    switchSession("ns-b", "/p/ns-b.jsonl");
    expect(screen.queryByText("A 会话的目标")).not.toBeInTheDocument();
    expect(container.querySelector("[data-goal-bar]")).toBeNull();
    // B 会话此时没有目标:回合收敛不该发任何续跑(A 的目标不在 B 里烧轮次)
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(0);
  });

  it("切回 A:目标条复活且轮次连续(不是 0、不是 B 的)", async () => {
    const { container } = render(<GoalBar />, { wrapper: GoalPluginWrapper });
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "A 会话的目标" } });
    // await:让续跑发送的 promise 落地,inflight 复位。否则第二次 agentSettled 会走
    // 「在飞欠账挂起」分支(deferred)而非重发——那是设计的正确行为(轮数推进与发送成对),
    // 不是本用例要验的东西,所以先把在飞态收干净。
    await act(async () => { emit({ type: "agentSettled" }); });   // A 跑一轮 → round 1
    expect(screen.getByText("1/1000")).toBeInTheDocument();
    const promptCallsAfterA = mocks.prompt.mock.calls.length;

    switchSession("ns-b", "/p/ns-b.jsonl");            // 切到 B 并设 B 自己的目标
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "B 会话的目标" } });
    expect(screen.getByText("B 会话的目标")).toBeInTheDocument();

    switchSession("ns-a", "/p/a.jsonl");               // 切回 A
    expect(screen.getByText("A 会话的目标")).toBeInTheDocument();
    expect(screen.getByText("1/1000")).toBeInTheDocument();   // 轮次连续,没被 B 污染
    expect(container.querySelector('[data-goal-phase="active"]')).not.toBeNull();
    // A 的回合收敛继续推进自己的轮次(同样 await 收干净在飞态)
    await act(async () => { emit({ type: "agentSettled" }); });
    expect(mocks.prompt).toHaveBeenCalledTimes(promptCallsAfterA + 1);
    expect(mocks.prompt.mock.calls[promptCallsAfterA][0]).toContain("A 会话的目标");
    expect(mocks.prompt.mock.calls[promptCallsAfterA][0]).toContain("Round: 2/1000");
  });

  it("A 跑着(busy)时切到 B:B 设目标不被 A 的 busy 压住(静默停摆守卫)", () => {
    render(<GoalBar />, { wrapper: GoalPluginWrapper });
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "A 的目标" } });
    emit({ type: "agentStart" });                      // A 进入在飞(busy=true 写进 A 的域)

    switchSession("ns-b", "/p/ns-b.jsonl");
    // B 设目标 + 手动暂停再恢复:恢复走 armIfIdle,若 busy 是全局的(A 的 true 残留)就会被否掉、
    // B 亮着 active 却没人发轮——这正是设计 §3.2.2 断点④ 的症状。
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "B 的目标" } });
    fireEvent.click(screen.getByTitle("停止"));
    const before = mocks.prompt.mock.calls.length;
    act(() => { fireEvent.click(screen.getByTitle("恢复")); });
    expect(mocks.prompt.mock.calls.length, "B 恢复后应立即装弹(A 的 busy 不该压住 B)").toBe(before + 1);
    expect(mocks.prompt.mock.calls[before][0]).toContain("B 的目标");
  });

  it("A 的发送失败红字不出现在 B 会话(sendError 也按会话隔离)", async () => {
    mocks.prompt.mockRejectedValue(new Error("网络炸了"));
    render(<GoalBar />, { wrapper: GoalPluginWrapper });
    await act(async () => { await runGoalCommand("/goal A 的目标"); });
    emit({ type: "agentSettled" });
    await act(async () => { await new Promise((r) => setTimeout(r, 4000)); });   // 耗尽 3 次重试
    expect(document.querySelector("[data-goal-send-error]")).not.toBeNull();

    switchSession("ns-b", "/p/ns-b.jsonl");
    expect(document.querySelector("[data-goal-send-error]"), "B 不该看到 A 的失败红字").toBeNull();
  });

  it("模型 set_goal 与用户 /goal 同状态机:工具设置的目标一样能删改停", async () => {
    render(<GoalBar />, { wrapper: GoalPluginWrapper });

    // 模型路径:中性事件 toolCallStart
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "模型设的目标" } });
    expect(screen.getByText("模型设的目标")).toBeInTheDocument();

    // 用户路径删改停照样生效
    fireEvent.click(screen.getByTitle("编辑目标"));
    fireEvent.change(screen.getByPlaceholderText("模型设的目标"), { target: { value: "用户改的" } });
    fireEvent.keyDown(screen.getByPlaceholderText("模型设的目标"), { key: "Enter" });
    expect(screen.getByText("用户改的")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("停止"));
    expect(screen.getByTitle("恢复")).toBeInTheDocument();
  });
});
