// goal 续跑引擎 —— 纯壳插件内的 hook,不动 core/application、不动契约/IPC。
//
// 薄壳架构(CLAUDE.md §1.2 机制与内容分离):「回合结束后再发一份 prompt 继续」是**功能(内容)**,
// 不是壳机制。壳只提供两个机制面——onEvent(订阅中性事件)与 prompt(发消息,= 发送按钮同源),
// 续跑逻辑就用这两个机制拼,活在这个插件里。
//
// 归约逻辑在 goal-reduce.ts(纯函数,可单测);本 hook 只做订阅 + 执行续跑提示的副作用。
// goal 状态在插件 renderer 内存,窗口刷新即清空(纯插件代价)。
import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginContext } from "@my-harness-desktop/react";
import type { GoalState } from "@my-harness-desktop/shared";
import { editGoal, pauseGoal, resumeGoal } from "@my-harness-desktop/shared";
import { applyGoalEvent } from "./goal-reduce";

/** goal 续跑 hook:返回当前目标 + 用户控制操作(停止/恢复/编辑/关闭)。 */
export function useGoalController() {
  const { sessions, messaging } = usePluginContext();
  const [goal, setGoalState] = useState<GoalState | null>(null);
  const goalRef = useRef<GoalState | null>(null);
  const inflightRef = useRef(false);

  const setGoal = useCallback((next: GoalState | null) => {
    goalRef.current = next;
    setGoalState(next);
  }, []);

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
