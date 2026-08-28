// goal 续跑引擎 —— 纯壳插件内的 hook,不动 core/application、不动契约/IPC。
//
// 薄壳架构(CLAUDE.md §1.2 机制与内容分离):「回合结束后再发一份 prompt 继续」是**功能(内容)**,
// 不是壳机制。壳只提供机制面——onEvent(订阅中性事件)、prompt(发消息,= 发送按钮同源)、
// updateHeader/openSession(会话头行 custom 域读写)、notify(命令反馈),续跑逻辑就用这些机制拼,
// 活在这个插件里。
//
// 持久化:goal 状态随变更写会话头行 custom.goal(插件域,域 key 归属制),挂载/切会话时读回——
// 窗口刷新不再丢目标。归约逻辑在 goal-reduce.ts(纯函数),本 hook 只做订阅 + 续跑副作用 + 持久化。
//
// 用户命令:人敲的 /goal 与模型调的 set_goal 互补。命令经壳机制 composerCommands
// (packages/react/composer-commands)在发送前拦到这里;handleCommand 是唯一实现,
// 经模块级桥(runGoalCommand)暴露给 renderer 入口的静态导出(plugins-host 收集)。
//
// 即时装弹(arming):设置/恢复/恢复持久化目标时若空闲(无回合在飞),立即发第一轮续跑提示——
// 否则没有任何东西会触发 agentSettled,active 目标会静默停摆;忙时交给在飞回合的 agentSettled。
import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginContext, useUiStore } from "@my-harness-desktop/react";
import type { GoalState } from "../core/goal-state";
import { createGoal, editGoal, parseGoal, parseGoalCommand, pauseGoal, resumeGoal, shouldContinue } from "../core/goal-state";
import { applyGoalEvent, renderContinuationPrompt } from "./goal-reduce";

export const GOAL_USAGE =
  "/goal <目标> 设置目标并开始续跑\n"
  + "/goal stop 暂停 · /goal resume 恢复 · /goal edit <新目标> 改 · /goal clear 删除 · /goal 查看状态";

/** 模块级桥:composerCommands.handle 是 plugins-host 收集的静态函数,控制器活在 React hook 里。
 *  GoalBar(composerStats 槽)与 composer 同时挂载,命令到来时控制器必在;无控制器(插件被禁)→ 放行。 */
let activeCommandHandler: ((input: string) => Promise<boolean>) | null = null;

/** 供 renderer 入口的 composerCommands 导出调用:转发给当前挂载的控制器。 */
export function runGoalCommand(input: string): Promise<boolean> {
  const fn = activeCommandHandler;
  return fn ? fn(input) : Promise.resolve(false);
}

/** goal 续跑 hook:返回当前目标 + 用户控制操作(停止/恢复/编辑/关闭)。 */
export function useGoalController() {
  const { sessions, messaging, notify, events } = usePluginContext();
  const sessionPath = useUiStore((s) => s.currentSessionPath);
  const [goal, setGoalState] = useState<GoalState | null>(null);
  const goalRef = useRef<GoalState | null>(null);
  const inflightRef = useRef(false);
  /** 回合在飞:agentStart 置真 / agentSettled 置假。决定设置/恢复/恢复持久化时是否立即发首轮续跑。 */
  const busyRef = useRef(false);

  /** 单一状态写入口:更新内存态 + 广播 goal:state(消费方着色用)+ 持久化到会话头行
   *  custom.goal(clear 时 goal=null 删键)。广播在写入口收口,任何路径变更不漏发。 */
  const setGoal = useCallback((next: GoalState | null) => {
    goalRef.current = next;
    setGoalState(next);
    events.emit("goal:state", { active: next !== null && next.phase === "active" });
    if (sessionPath) {
      void sessions.updateHeader(sessionPath, { custom: { goal: next } }).catch(() => {
        // 持久化失败不阻断续跑(内存态照常),下次变更再写。
      });
    }
  }, [events, sessions, sessionPath]);

  /** 发一轮续跑提示(与发送按钮同源)。失败不风暴重试——目标保持 active,下次 agentSettled 自然再续。 */
  const sendRound = useCallback((g: GoalState, round: number) => {
    inflightRef.current = true;
    void messaging.prompt(renderContinuationPrompt(g.objective, round, g.maxRounds))
      .catch(() => { /* 发送失败:目标保持 active,下次 agentSettled 自然再续 */ })
      .finally(() => { inflightRef.current = false; });
  }, [messaging]);

  /** 空闲且应续跑 → 立即装下一轮并返回推进后的状态;忙/在飞/不该续 → 原样返回。 */
  const armIfIdle = useCallback((g: GoalState): GoalState => {
    if (busyRef.current || inflightRef.current || !shouldContinue(g)) return g;
    const round = g.round + 1;
    const next = { ...g, round };
    sendRound(next, round);
    return next;
  }, [sendRound]);

  // 读:挂载/切会话时从会话头行 custom.goal 恢复目标(窗口刷新不再丢)。
  // 恢复出的 active 目标立即装弹——「active=续跑中」不因窗口刷新停摆。
  useEffect(() => {
    let alive = true;
    if (!sessionPath) return;
    void sessions.openSession(sessionPath)
      .then((detail) => {
        if (!alive) return;
        const custom = (detail as { info?: { custom?: Record<string, unknown> } } | null)?.info?.custom;
        const restored = parseGoal(custom?.goal);
        if (!restored) return;
        setGoal(restored.phase === "active" ? armIfIdle(restored) : restored);
      })
      .catch(() => { /* 会话未就绪/读失败:保持无目标,下次切换再读 */ });
    return () => { alive = false; };
  }, [sessions, sessionPath, setGoal, armIfIdle]);

  // 续跑事件订阅:toolCallStart 捕获 set_goal/achieve_goal,agentSettled 判定续跑;
  // agentStart/agentSettled 同时维护 busy(用户命令的即时装弹判据)。
  useEffect(() => {
    return sessions.onEvent((event) => {
      if (event.type === "agentStart") busyRef.current = true;
      const { goal: next, prompt } = applyGoalEvent(goalRef.current, event);
      if (event.type === "agentSettled") busyRef.current = false;
      if (next !== goalRef.current) setGoal(next);
      if (prompt !== undefined && !inflightRef.current) {
        inflightRef.current = true;
        void messaging.prompt(prompt)
          .catch(() => { /* 发送失败:目标保持 active,不风暴重试 */ })
          .finally(() => { inflightRef.current = false; });
      }
    });
  }, [sessions, messaging, setGoal]);

  const pause = useCallback(() => { const g = goalRef.current; if (g) setGoal(pauseGoal(g)); }, [setGoal]);
  // 恢复即「继续干活」:空闲时立即装下一轮,不等下一次回合收敛(否则 active 但无人触发,停摆)。
  const resume = useCallback(() => { const g = goalRef.current; if (g) setGoal(armIfIdle(resumeGoal(g))); }, [setGoal, armIfIdle]);
  const edit = useCallback((objective: string) => {
    const g = goalRef.current;
    if (!g) return;
    try { setGoal(editGoal(g, objective)); } catch { /* 空 objective 忽略 */ }
  }, [setGoal]);
  const clear = useCallback(() => setGoal(null), [setGoal]);

  /** 用户 /goal 命令的唯一实现:解析 → 套状态机 → 通知反馈。返回 true = 吞掉本次发送。
   *  与模型工具同状态机同持久化:人敲 /goal 和模型调 set_goal 落到同一个 GoalState。 */
  const handleCommand = useCallback(async (input: string): Promise<boolean> => {
    const cmd = parseGoalCommand(input);
    if (!cmd) return false;
    const g = goalRef.current;
    const notifyNoGoal = (): void => {
      void notify.show({ title: "Goal", body: "当前没有目标。用 /goal <目标内容> 设置。", silent: true });
    };
    switch (cmd.kind) {
      case "set": {
        try {
          setGoal(armIfIdle(createGoal(cmd.request)));
        } catch {
          void notify.show({ title: "Goal", body: GOAL_USAGE, silent: true });
        }
        return true;
      }
      case "pause":
        if (g) setGoal(pauseGoal(g)); else notifyNoGoal();
        return true;
      case "resume":
        if (g) setGoal(armIfIdle(resumeGoal(g))); else notifyNoGoal();
        return true;
      case "edit":
        if (!g) { notifyNoGoal(); return true; }
        try { setGoal(editGoal(g, cmd.objective)); }
        catch { void notify.show({ title: "Goal", body: GOAL_USAGE, silent: true }); }
        return true;
      case "clear":
        setGoal(null);
        return true;
      case "status":
        void notify.show({
          title: "Goal",
          body: g ? `[${g.phase}] ${g.round}/${g.maxRounds} · ${g.objective}` : GOAL_USAGE,
          silent: true,
        });
        return true;
    }
  }, [notify, setGoal, armIfIdle]);

  // 桥接:把当前控制器挂到模块级入口(静态导出侧)。卸载时只清自己,不误伤后续挂载者。
  const handleCommandRef = useRef(handleCommand);
  handleCommandRef.current = handleCommand;
  useEffect(() => {
    const fn = (input: string): Promise<boolean> => handleCommandRef.current(input);
    activeCommandHandler = fn;
    return () => { if (activeCommandHandler === fn) activeCommandHandler = null; };
  }, []);

  return { goal, pause, resume, edit, clear };
}
