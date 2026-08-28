// goal 续跑引擎 —— 纯壳插件内的 hook,不动 core/application、不动契约/IPC。
//
// 薄壳架构(CLAUDE.md §1.2 机制与内容分离):「回合结束后再发一份 prompt 继续」是**功能(内容)**,
// 不是壳机制。壳只提供机制面——onEvent(订阅中性事件)、prompt(发消息,= 发送按钮同源)、
// updateHeader/openSession(会话头行 custom 域读写),续跑逻辑就用这些机制拼,活在这个插件里。
//
// 持久化:goal 状态随变更写会话头行 custom.goal(插件域,域 key 归属制),挂载/切会话时读回——
// 窗口刷新不再丢目标。归约逻辑在 goal-reduce.ts(纯函数),本 hook 只做订阅 + 续跑副作用 + 持久化。
import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginContext, useUiStore } from "@my-harness-desktop/react";
import type { GoalState } from "../core/goal-state";
import { editGoal, parseGoal, pauseGoal, resumeGoal } from "../core/goal-state";
import { applyGoalEvent } from "./goal-reduce";

/** goal 续跑 hook:返回当前目标 + 用户控制操作(停止/恢复/编辑/关闭)。 */
export function useGoalController() {
  const { sessions, messaging } = usePluginContext();
  const sessionPath = useUiStore((s) => s.currentSessionPath);
  const [goal, setGoalState] = useState<GoalState | null>(null);
  const goalRef = useRef<GoalState | null>(null);
  const inflightRef = useRef(false);

  /** 单一状态写入口:更新内存态 + 持久化到会话头行 custom.goal(clear 时 goal=null 删键)。 */
  const setGoal = useCallback((next: GoalState | null) => {
    goalRef.current = next;
    setGoalState(next);
    if (sessionPath) {
      void sessions.updateHeader(sessionPath, { custom: { goal: next } }).catch(() => {
        // 持久化失败不阻断续跑(内存态照常),下次变更再写。
      });
    }
  }, [sessions, sessionPath]);

  // 读:挂载/切会话时从会话头行 custom.goal 恢复目标(窗口刷新不再丢)。
  useEffect(() => {
    let alive = true;
    if (!sessionPath) return;
    void sessions.openSession(sessionPath)
      .then((detail) => {
        if (!alive) return;
        const custom = (detail as { info?: { custom?: Record<string, unknown> } } | null)?.info?.custom;
        const restored = parseGoal(custom?.goal);
        if (restored) setGoal(restored);
      })
      .catch(() => { /* 会话未就绪/读失败:保持无目标,下次切换再读 */ });
    return () => { alive = false; };
  }, [sessions, sessionPath, setGoal]);

  // 续跑事件订阅:toolCallStart 捕获 set_goal/achieve_goal,agentSettled 判定续跑。
  useEffect(() => {
    return sessions.onEvent((event) => {
      const { goal: next, prompt } = applyGoalEvent(goalRef.current, event);
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
  const resume = useCallback(() => { const g = goalRef.current; if (g) setGoal(resumeGoal(g)); }, [setGoal]);
  const edit = useCallback((objective: string) => {
    const g = goalRef.current;
    if (!g) return;
    try { setGoal(editGoal(g, objective)); } catch { /* 空 objective 忽略 */ }
  }, [setGoal]);
  const clear = useCallback(() => setGoal(null), [setGoal]);

  return { goal, pause, resume, edit, clear };
}
