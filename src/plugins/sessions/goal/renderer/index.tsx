// goal 插件 renderer 入口 —— manifest component 名与 export 一一对应（框架自动匹配）。
export { GoalCard } from "./goal-card";
export { GoalBar } from "./goal-bar";
export { GoalRoundCard } from "./goal-round-card";
export { GoalNoteCard } from "./goal-note-card";

// ============ 会话作用域槽(设计 docs/design/session-scope.md §2.4.1/§3.2.1) ============
//
// goal 的目标态此前是**模块级单例**(currentGoal/goalBirthPath/lastSendError)+ hook ref,
// 靠异步 effect + 字符串路径比对补换档,于是有四个断点:新会话目标条不清、goalBirthPath
// 名不副实、物化补写是死代码、busy 跨会话残留导致静默停摆(设计 §1.3.3/§3.2.2)。
// 迁入作用域槽后:每个会话各一份、切会话自动换档、物化由框架 carry 搬迁——四段手动
// 隔离代码(物化补写分支/foreign 判据/alive 守卫/模块级监听器集合)全部失去存在理由。
//
// goal 与 sendError 用缺省 move:物化时目标该跟着走。三个执行瞬态用 drop:物化后由
// 内核事件重新建立,搬过去等于把壳会话的过期描述当真身现状(设计 §2.6.3)。
//
// onCarry 补写头行:壳键期间会话尚未落盘、updateHeader 够不到文件,物化那一刻 carry 把
// 内存槽搬到真身键后调 onCarry,goal 在里面把 custom.goal 写进真身头行(设计 §3.2.3)。
// 声明是静态 export(plugins-host 收集时没有 PluginContext),所以经模块桥转发到当前挂载的
// 控制器——与下面 composerCommands 的 runGoalCommand 同一手法。
import type { SessionSlot } from "@my-harness-desktop/shared";
import type { GoalState } from "../core/goal-state";
import { persistGoalOnCarry } from "./goal-controller";

export const sessionSlots: SessionSlot[] = [
  {
    id: "goal",
    initial: null as GoalState | null,
    onCarry: (value, toKey) => persistGoalOnCarry(value as GoalState | null, toKey),
  },
  { id: "sendError", initial: null as string | null },
  { id: "busy", initial: false, carry: "drop" },
  { id: "inflight", initial: false, carry: "drop" },
  { id: "deferred", initial: false, carry: "drop" },
];

// goal:state —— 目标状态广播(内容层事件,机制 = 事件总线):payload { goal: GoalState | null }
// (全量快照)。消费方 timeline 订阅后按 phase 给输入框着色(生效绿晕),不直读本插件内部状态
// (插件间只走事件,§8.2)。
//
// scope:"session"(设计 §2.5):框架自动注入会话坐标、按坐标过滤投递、replayLast 按坐标分桶。
// 此前 payload 只有 {goal} 不带坐标,而 replayLast 的 lastPayload 每 channel 一份不分桶——
// timeline 任何一次重挂载都回放上一个会话的目标态,绿晕挂错(设计 §1.3.4)。声明 scope 后
// 由框架物理保证不串台,插件的 emit/on 两侧代码一行不改(坐标是传输层信封)。
export const channels = ["goal:state"] as const;
export const channelMeta = {
  "goal:state": {
    scope: "session" as const,
    label: "目标状态",
    description: "当前会话目标的全量快照 { goal: GoalState | null }。timeline 订阅后按 phase 给输入框着色。",
  },
};

// 续跑提示(<goal_round> 包装)从用户消息里剥出渲染成「目标续跑卡」(所见即所得,
// 用户要求 #5——加了包装就换种方式展示,不冒充用户气泡)。auxParsers 与 channels
// 同款收集模式:plugins-host 加载本 module 时注册。
import type { AuxBlockParser } from "@my-harness-desktop/shared";
import { goalRoundParser } from "./goal-round-parser";
export const auxParsers: AuxBlockParser[] = [goalRoundParser];

// 用户斜杠命令(机制 = packages/react/composer-commands,与 channels/auxParsers 同款模块导出收集):
// /goal 由人在输入框敲,发送前被拦到本插件处理——与模型调 set_goal 互补,同一状态机同一持久化。
// handle 是静态函数(插件加载时收集),经 runGoalCommand 桥到当前挂载的续跑控制器。
// /goal <目标> 返回 { send: 目标正文 }(所见即所得:目标作为真实用户消息发出);
// stop/resume/edit/clear/status 返回 true(纯命令,吞掉发送)。
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
