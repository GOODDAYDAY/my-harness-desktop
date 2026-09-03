// @vitest-environment jsdom
// goal 续跑引擎 e2e:useGoalController 全链路,证明 goal 能成功完成 + 跨刷新持久化。
// 模型 set_goal → 回合收敛续跑 → 模型 achieve_goal → 停止;并覆盖用户停止/恢复/编辑/关闭、
// 挂载恢复(从会话头行 custom.goal 读回)、变更落盘(写回 custom.goal)。
// mock 框架的 usePluginContext/useUiStore(只提供 onEvent/prompt/updateHeader/openSession 机制面),续跑逻辑全真跑。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SessionEvent } from "@my-harness-desktop/shared";

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  updateHeader: vi.fn(),
  openSession: vi.fn(),
  notify: vi.fn(),
  eventsEmit: vi.fn(),
  onEventCb: null as ((e: SessionEvent) => void) | null,
  pendingQueue: {} as Record<string, { id: string }[]>,
  generalConfig: {} as Record<string, unknown>,
  messages: [] as unknown[],
}));

vi.mock("@my-harness-desktop/react", () => {
  // 稳定 API 对象:若每次 render 返回新对象,useGoalController 的 useEffect 依赖会每帧变化、无限重跑。
  const sessions = {
    onEvent: (cb: (e: SessionEvent) => void) => {
      mocks.onEventCb = cb;
      return () => { mocks.onEventCb = null; };
    },
    updateHeader: mocks.updateHeader,
    openSession: mocks.openSession,
  };
  const messaging = { prompt: mocks.prompt };
  const notify = { show: mocks.notify };
  const events = { emit: mocks.eventsEmit, on: vi.fn(() => () => {}) };
  const stateOf = (): { currentSessionPath: string; pendingQueue: Record<string, { id: string }[]>; generalConfig: Record<string, unknown> } =>
    ({ currentSessionPath: "/p/s.jsonl", pendingQueue: mocks.pendingQueue, generalConfig: mocks.generalConfig });
  const useUiStore = Object.assign(
    (selector?: (s: ReturnType<typeof stateOf>) => unknown) => (selector ? selector(stateOf()) : stateOf()),
    { getState: stateOf },
  );
  // useSessionStore:异常收敛检测读 messages(error/stopped 终结标记)。默认空历史=正常收敛。
  const useSessionStore = Object.assign(
    (selector?: (s: { messages: unknown[] }) => unknown) =>
      (selector ? selector({ messages: mocks.messages }) : { messages: mocks.messages }),
    { getState: () => ({ messages: mocks.messages }) },
  );
  return {
    usePluginContext: () => ({ sessions, messaging, notify, events }),
    useUiStore,
    useSessionStore,
  };
});

import { useGoalController, runGoalCommand, __resetGoalStoreForTests } from "./goal-controller";

function emit(e: SessionEvent): void {
  act(() => { mocks.onEventCb?.(e); });
}

describe("goal 续跑引擎 e2e(useGoalController)", () => {
  beforeEach(() => {
    mocks.prompt.mockReset();
    mocks.prompt.mockResolvedValue(undefined);
    mocks.updateHeader.mockReset();
    mocks.updateHeader.mockResolvedValue(undefined);
    mocks.openSession.mockReset();
    mocks.openSession.mockResolvedValue(null); // 默认无既有目标
    mocks.notify.mockReset();
    mocks.notify.mockResolvedValue(undefined);
    mocks.eventsEmit.mockReset();
    mocks.onEventCb = null;
    mocks.pendingQueue = {};
    mocks.generalConfig = {}; // 通用配置默认空(代码兜底 1000)
    mocks.messages = []; // 默认无历史=正常收敛(异常收敛检测)
    __resetGoalStoreForTests(); // 模块级目标态(抗重挂载单例)测试间隔离
  });

  it("set_goal → 续跑 → achieve_goal → 停止(完整闭环)", () => {
    const { result } = renderHook(() => useGoalController());

    // 模型调 set_goal → 建立 active 目标
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "写 README" } });
    expect(result.current.goal?.phase).toBe("active");
    expect(result.current.goal?.objective).toBe("写 README");

    // 回合收敛 → 注入续跑提示(与发送同源)
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("写 README");
    expect(mocks.prompt.mock.calls[0][0]).toContain("<goal_round>");

    // 模型调 achieve_goal → 标记达成
    emit({ type: "toolCallStart", toolName: "achieve_goal" });
    expect(result.current.goal?.phase).toBe("achieved");

    // 回合再收敛 → 不再续跑(证明完成即终止)
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
  });

  it("用户停止(pause)后不再续跑,恢复(resume)后继续", async () => {
    const { result } = renderHook(() => useGoalController());

    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "x" } });
    act(() => { result.current.pause(); });
    expect(result.current.goal?.phase).toBe("paused");

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(0); // 暂停不续跑

    // 恢复即「继续干活」:空闲时立即装第一轮(不等下一次回合收敛,否则 active 无人触发会停摆)。
    // 异步 act:flush 掉 prompt 的 finally 微任务(inflight 护栏复位),否则下一条事件被护栏挡住。
    await act(async () => { result.current.resume(); });
    expect(result.current.goal?.phase).toBe("active");
    expect(result.current.goal?.round).toBe(1);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("<goal_round>");

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(2); // 恢复后继续
  });

  it("编辑(edit)下次续跑生效,关闭(clear)后不再续跑", () => {
    const { result } = renderHook(() => useGoalController());

    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "旧目标" } });
    act(() => { result.current.edit("新目标"); });
    expect(result.current.goal?.objective).toBe("新目标");

    emit({ type: "agentSettled" });
    expect(mocks.prompt.mock.calls[0][0]).toContain("新目标"); // 下次续跑用新目标

    act(() => { result.current.clear(); });
    expect(result.current.goal).toBeNull();

    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 清空后不再续跑
  });

  it("挂载时从会话头行恢复目标,变更时写回头行(跨刷新持久化)", async () => {
    mocks.openSession.mockResolvedValue({
      info: { custom: { goal: { objective: "持久化目标", phase: "active", round: 2, maxRounds: 8 } } },
    });
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await Promise.resolve(); });

    // 恢复:窗口刷新后目标从 custom.goal 读回;active 目标立即装弹续跑(2→3 轮),不因刷新停摆
    expect(result.current.goal?.objective).toBe("持久化目标");
    expect(result.current.goal?.round).toBe(3);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("Round: 3/8");

    // 变更写回:模型重新 set_goal → 已有 active 目标时收敛为「改」(保轮次,不重置),
    // updateHeader 落 custom.goal
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "新目标" } });
    expect(mocks.updateHeader).toHaveBeenCalledWith(
      "/p/s.jsonl",
      { custom: { goal: expect.objectContaining({ objective: "新目标", phase: "active", round: 3 }) } },
    );
  });

  it("关闭(clear)落盘 goal=null 删键", () => {
    const { result } = renderHook(() => useGoalController());
    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "x" } });
    act(() => { result.current.clear(); });
    expect(mocks.updateHeader).toHaveBeenLastCalledWith("/p/s.jsonl", { custom: { goal: null } });
  });

  // —— 用户 /goal 命令(人敲,与模型 set_goal 互补)——

  it("/goal <目标>:所见即所得——目标落状态 + 返回 {send:目标正文} 交 timeline 真发(不吞不改写)", async () => {
    const { result } = renderHook(() => useGoalController());

    let handled: Awaited<ReturnType<typeof runGoalCommand>> | undefined;
    await act(async () => { handled = await runGoalCommand("/goal 把测试全跑绿"); });

    // 命令不再吞文本:返回改写结果,目标正文作为真实用户消息发出去
    expect(handled).toEqual({ send: "把测试全跑绿" });
    expect(result.current.goal?.objective).toBe("把测试全跑绿");
    expect(result.current.goal?.phase).toBe("active");
    // set 不装弹(round=0):kickoff 消息本身就是第 0 轮,它的 agentSettled 自然接第 1 轮
    expect(result.current.goal?.round).toBe(0);
    expect(mocks.prompt).toHaveBeenCalledTimes(0);
    expect(mocks.updateHeader).toHaveBeenCalledWith(
      "/p/s.jsonl",
      { custom: { goal: expect.objectContaining({ objective: "把测试全跑绿", round: 0 }) } },
    );

    // kickoff 回合收敛 → 第 1 轮续跑
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("把测试全跑绿");
    expect(mocks.prompt.mock.calls[0][0]).toContain("Round: 1/1000");

    // 第 1 轮收敛 → 第 2 轮自然接续(先 flush continue 的落定微任务——在飞窗口
    // 是真实互斥:上一轮还没发完时收敛只挂欠账,落定才补发,见「三轮只发两轮」回归)
    await act(async () => { await Promise.resolve(); });
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(mocks.prompt.mock.calls[1][0]).toContain("Round: 2/1000");
  });

  it("/goal <目标>:忙时(回合在飞)不立即发,由在飞回合的 agentSettled 触发首轮", async () => {
    const { result } = renderHook(() => useGoalController());

    emit({ type: "agentStart" }); // 回合在飞
    await act(async () => { await runGoalCommand("/goal 忙时设置"); });

    expect(result.current.goal?.round).toBe(0); // 未装弹
    expect(mocks.prompt).toHaveBeenCalledTimes(0);

    emit({ type: "agentSettled" }); // 在飞回合收敛 → 首轮
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("Round: 1/1000");
  });

  it("/goal stop·resume·edit·clear 子命令走同一状态机", async () => {
    const { result } = renderHook(() => useGoalController());

    await act(async () => { await runGoalCommand("/goal 原目标"); });
    expect(result.current.goal?.phase).toBe("active");

    await act(async () => { await runGoalCommand("/goal stop"); });
    expect(result.current.goal?.phase).toBe("paused");
    emit({ type: "agentSettled" });
    const callsAfterPause = mocks.prompt.mock.calls.length; // 暂停不续跑

    await act(async () => { await runGoalCommand("/goal edit 改过的目标"); });
    expect(result.current.goal?.objective).toBe("改过的目标");

    await act(async () => { await runGoalCommand("/goal resume"); });
    expect(result.current.goal?.phase).toBe("active");
    expect(mocks.prompt.mock.calls.length).toBe(callsAfterPause + 1); // 恢复即装弹

    await act(async () => { await runGoalCommand("/goal clear"); });
    expect(result.current.goal).toBeNull();
    expect(mocks.updateHeader).toHaveBeenLastCalledWith("/p/s.jsonl", { custom: { goal: null } });
  });

  it("/goal limit <n>:只换上限——到顶停摆的目标提高后空闲即装弹续跑", async () => {
    mocks.generalConfig = {};
    const { result } = renderHook(() => useGoalController());

    // 建一个上限 2 的目标并跑到到顶(round=2,active 但 shouldContinue 不成立)
    await act(async () => { await runGoalCommand("/goal 短上限目标"); });
    await act(async () => { await runGoalCommand("/goal limit 2"); });
    expect(result.current.goal?.maxRounds).toBe(2);
    emit({ type: "agentSettled" }); // round 1
    await act(async () => { await Promise.resolve(); });
    emit({ type: "agentSettled" }); // round 2
    await act(async () => { await Promise.resolve(); });
    emit({ type: "agentSettled" }); // 到顶:不再续跑
    const callsAtTop = mocks.prompt.mock.calls.length;
    expect(result.current.goal?.round).toBe(2);

    // 提高上限 → 空闲装弹:立即补发一轮,轮次 3
    await act(async () => { await runGoalCommand("/goal limit 5"); });
    expect(result.current.goal?.maxRounds).toBe(5);
    expect(result.current.goal?.phase).toBe("active");
    expect(result.current.goal?.round).toBe(3);
    expect(mocks.prompt.mock.calls.length).toBe(callsAtTop + 1);
    expect(mocks.prompt.mock.calls.at(-1)?.[0]).toContain("Round: 3/5");
  });

  it("/goal limit:畸形参数降级状态提示,不动目标;无目标时提示而非崩溃", async () => {
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 原目标"); });
    const before = result.current.goal;
    await act(async () => { await runGoalCommand("/goal limit abc"); });
    expect(result.current.goal).toEqual(before); // 目标原样
    expect(mocks.notify).toHaveBeenCalled(); // 降级状态提示
  });

  it("创建目标时读取通用配置 goal.maxRounds 作为默认上限(进行中目标不受后续配置变更影响)", async () => {
    mocks.generalConfig = { "goal.maxRounds": 500 };
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 配置上限目标"); });
    expect(result.current.goal?.maxRounds).toBe(500);
    emit({ type: "agentSettled" });
    expect(mocks.prompt.mock.calls[0][0]).toContain("Round: 1/500");

    // 配置后改不动存量目标(固化在状态里,设计 §11 QA)
    mocks.generalConfig = { "goal.maxRounds": 5000 };
    expect(result.current.goal?.maxRounds).toBe(500);
  });

  it("续跑发送失败:有界重试耗尽 → 转 paused + 失败显形;resume 清失败态并装弹(§6.4)", async () => {
    vi.useFakeTimers();
    try {
      mocks.prompt.mockReset();
      mocks.prompt.mockRejectedValue(new Error("会话未启动，请先选择模型"));
      const { result } = renderHook(() => useGoalController());

      await act(async () => { await runGoalCommand("/goal 会失败的目标"); });
      emit({ type: "agentSettled" }); // 第 1 轮触发发送(将失败)
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); // 跑完 2 次退避重试

      expect(mocks.prompt).toHaveBeenCalledTimes(3); // 首发 + 2 次重试
      expect(result.current.goal?.phase).toBe("paused"); // 耗尽 → paused(不空等不会来的 agentSettled)
      expect(result.current.sendError).toContain("会话未启动");
      expect(mocks.notify).toHaveBeenCalled();

      // resume 清失败态并重新装弹
      mocks.prompt.mockReset();
      mocks.prompt.mockResolvedValue(undefined);
      await act(async () => { await runGoalCommand("/goal resume"); });
      expect(result.current.goal?.phase).toBe("active");
      expect(result.current.sendError).toBeNull();
      expect(mocks.prompt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("异常收敛不续跑:报错回合转 paused 并显形;人为中断转 paused(§5.2)", async () => {
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 异常收敛目标"); });

    // 报错收敛:最后一条 assistant 消息 error=true(messageEnd 已先于 agentSettled 落 store)
    mocks.messages = [{ role: "assistant", content: "x", error: true }];
    emit({ type: "agentSettled" });
    expect(result.current.goal?.phase).toBe("paused");
    expect(result.current.sendError).toBeTruthy();
    expect(mocks.prompt).toHaveBeenCalledTimes(0); // 不续跑
    expect(mocks.notify).toHaveBeenCalled();

    // 恢复后正常装弹
    await act(async () => { await runGoalCommand("/goal resume"); });
    expect(result.current.goal?.phase).toBe("active");
    expect(mocks.prompt).toHaveBeenCalledTimes(1);

    // 人为中断:stopped=true → 转 paused,不发错误通知(人在场,不是故障)
    mocks.notify.mockClear();
    mocks.messages = [{ role: "assistant", content: "x", stopped: true }];
    emit({ type: "agentSettled" });
    expect(result.current.goal?.phase).toBe("paused");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("正常收敛不受终结检测影响:最后一条 assistant 无标记 → 照常续跑", async () => {
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 正常目标"); });
    mocks.messages = [{ role: "assistant", content: "活干完了" }];
    emit({ type: "agentSettled" });
    expect(result.current.goal?.phase).toBe("active");
    expect(result.current.goal?.round).toBe(1);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
  });

  it("裸 /goal 查看状态(通知);无目标时子命令提示而非崩溃(仍吞发送)", async () => {
    const { result } = renderHook(() => useGoalController());
    void result;

    let handled: Awaited<ReturnType<typeof runGoalCommand>> | undefined;
    await act(async () => { handled = await runGoalCommand("/goal"); });
    expect(handled).toBe(true);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0].body).toContain("/goal"); // 无目标 → 用法提示

    await act(async () => { handled = await runGoalCommand("/goal stop"); });
    expect(handled).toBe(true); // 无目标的 stop 也吞掉,不进内核
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it("已有目标时裸 /goal 回显当前状态", async () => {
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 状态回显目标"); });

    await act(async () => { await runGoalCommand("/goal"); });
    const last = mocks.notify.mock.calls[mocks.notify.mock.calls.length - 1][0];
    expect(last.body).toContain("状态回显目标");
    expect(last.body).toContain("active");
    void result;
  });

  it("非 /goal 文本放行(返回 false,照常发送)", async () => {
    renderHook(() => useGoalController());

    let handled: Awaited<ReturnType<typeof runGoalCommand>> | undefined;
    await act(async () => { handled = await runGoalCommand("普通消息"); });
    expect(handled).toBe(false);
    await act(async () => { handled = await runGoalCommand("/goalx 不是 goal 命令"); });
    expect(handled).toBe(false);
    expect(mocks.prompt).toHaveBeenCalledTimes(0);
  });

  it("goal:state 状态广播:全量快照(消费方取 phase 着色,paused/achieved/无目标可区分)", async () => {
    renderHook(() => useGoalController());

    const phases = (): (string | null)[] =>
      mocks.eventsEmit.mock.calls.map((c) => (c[1] as { goal: { phase: string } | null }).goal?.phase ?? null);

    await act(async () => { await runGoalCommand("/goal 广播目标"); });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { goal: expect.objectContaining({ phase: "active", objective: "广播目标" }) });

    await act(async () => { await runGoalCommand("/goal stop"); });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { goal: expect.objectContaining({ phase: "paused" }) });

    await act(async () => { await runGoalCommand("/goal resume"); });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { goal: expect.objectContaining({ phase: "active" }) });

    await act(async () => { await runGoalCommand("/goal clear"); });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { goal: null });

    // 全程通道名不变,payload 是全量快照
    expect(mocks.eventsEmit.mock.calls.every((c) => c[0] === "goal:state")).toBe(true);
    expect(phases()).toEqual(["active", "paused", "active", null]);
  });

  it("模型 set_goal / achieve_goal 也广播(工具路径与命令路径同收口)", () => {
    renderHook(() => useGoalController());

    emit({ type: "toolCallStart", toolName: "set_goal", args: { objective: "工具设的目标" } });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { goal: expect.objectContaining({ phase: "active" }) });

    emit({ type: "toolCallStart", toolName: "achieve_goal" });
    expect(mocks.eventsEmit).toHaveBeenLastCalledWith("goal:state", { goal: expect.objectContaining({ phase: "achieved" }) });
  });

  it("用户输入插队:收敛时有排队用户消息 → 本次不续跑不进轮次,队列清空后的收敛再续", async () => {
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 插队测试目标"); });
    expect(mocks.prompt).toHaveBeenCalledTimes(0); // set 不装弹,kickoff 收敛才接第 1 轮

    // kickoff 回合收敛 → 第 1 轮
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1);

    // 流式期用户排队了一条消息(经 timeline 入 ui-store.pendingQueue)
    mocks.pendingQueue = { s: [{ id: "u1" }] };
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 续跑让路,没抢发
    expect(result.current.goal?.round).toBe(1); // 轮次不空转

    // 用户消息发出、回合收敛、队列已清 → 续跑接上(先 flush 第 1 轮的落定微任务)
    await act(async () => { await Promise.resolve(); });
    mocks.pendingQueue = {};
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(result.current.goal?.round).toBe(2);
    expect(mocks.prompt.mock.calls[1][0]).toContain("插队测试目标");
  });

  it("用户输入插队:排队未清时恢复也不即时装弹,等用户回合收敛再续", async () => {
    const { result } = renderHook(() => useGoalController());
    await act(async () => { await runGoalCommand("/goal 恢复插队目标"); });
    await act(async () => { await runGoalCommand("/goal stop"); });
    const calls = mocks.prompt.mock.calls.length;

    mocks.pendingQueue = { s: [{ id: "u2" }] };
    await act(async () => { await runGoalCommand("/goal resume"); });
    expect(result.current.goal?.phase).toBe("active"); // 状态恢复
    expect(mocks.prompt).toHaveBeenCalledTimes(calls); // 但不抢发,让位排队用户输入

    mocks.pendingQueue = {};
    emit({ type: "agentSettled" }); // 用户消息的回合收敛
    expect(mocks.prompt).toHaveBeenCalledTimes(calls + 1); // 续跑此时才接上
  });

  it("续跑撞上在飞(慢 RPC):轮次不丢不空转——欠账挂起,inflight 落定按最新状态补发(「三轮只发两轮」根因回归)", async () => {
    const { result } = renderHook(() => useGoalController());

    // 让 continue 的在飞窗口可控
    let release: (() => void) | null = null;
    mocks.prompt.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));

    await act(async () => { await runGoalCommand("/goal 三轮目标"); });
    emit({ type: "agentSettled" }); // 第 1 轮发出(在飞中)
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("Round: 1/1000");

    // 第 1 轮的 continue 还没落定,回合收敛就到了 → 欠账挂起:不推进 round、不丢 prompt
    emit({ type: "agentSettled" });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 没有并发再发
    expect(result.current.goal?.round).toBe(1); // 轮次不空转(旧实现此处已推进到 2 但 prompt 被丢)

    // inflight 落定 → 欠账按最新状态补发第 2 轮
    await act(async () => { release!(); });
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(mocks.prompt.mock.calls[1][0]).toContain("Round: 2/1000");
    expect(result.current.goal?.round).toBe(2);
  });

  it("欠账挂起期间用户暂停:inflight 落定不补发(尊重最新阶段)", async () => {
    const { result } = renderHook(() => useGoalController());

    let release: (() => void) | null = null;
    mocks.prompt.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));

    await act(async () => { await runGoalCommand("/goal 会被暂停的目标"); });
    emit({ type: "agentSettled" }); // 第 1 轮在飞
    emit({ type: "agentSettled" }); // 欠账挂起

    await act(async () => { result.current.pause(); }); // 落定前用户暂停
    await act(async () => { release!(); });
    expect(mocks.prompt).toHaveBeenCalledTimes(1); // 不补发
    expect(result.current.goal?.phase).toBe("paused");
    expect(result.current.goal?.round).toBe(1);
  });
});
