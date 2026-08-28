// goal 插件 renderer 入口 —— manifest component 名与 export 一一对应（框架自动匹配）。
export { GoalCard } from "./goal-card";
export { GoalBar } from "./goal-bar";

// 用户斜杠命令(机制 = packages/react/composer-commands,与 channels/auxParsers 同款模块导出收集):
// /goal 由人在输入框敲,发送前被拦到本插件处理——与模型调 set_goal 互补,同一状态机同一持久化。
// handle 是静态函数(插件加载时收集),经 runGoalCommand 桥到当前挂载的续跑控制器。
import type { ComposerCommand } from "@my-harness-desktop/shared";
import { GOAL_COMMAND_NAME } from "../core/goal-state";
import { runGoalCommand } from "./goal-controller";

export const composerCommands: ComposerCommand[] = [
  {
    name: GOAL_COMMAND_NAME,
    description: "设置/管理本会话目标(自动续跑)。/goal <目标> 设置;stop·resume·edit·clear 控制",
    handle: (input) => runGoalCommand(input),
  },
];
