// goal 续跑驱动 —— application 层:内核无关的同会话目标续跑编排。
//
// 设计 docs/design/kernel-agnostic-goal.md。定位:goal 是**壳层机制**,不 import 任何具体内核。
// 驱动只依赖中性事件流(SessionEvent)+ 一个「发消息」的中性口子(host.prompt),与 pi/dsh 无关:
// - 模型调 set_goal → 中性 toolCallStart 事件被驱动捕获 → 建立目标(active)
// - 模型调 achieve_goal → 中性 toolCallStart 事件被驱动捕获 → 标记达成(achieved)
// - 每次 agentSettled(回合收敛)时若目标 active 且未达轮数上限 → host.prompt 注入续跑提示,
//   新一轮结束再判 —— 直到 achieve_goal 或超轮数上限为止。
//
// 内核无关的证明:本文件不 import client/{kernel},只 import 圆心契约 + 中性事件类型。
// 换内核 = 换 host.prompt 的实现(assembly 绑定),本文件一行不改。

import type { GoalState, SessionEvent } from "@my-harness-desktop/shared";
import { achieveGoal, createGoal, parseSetGoalArgs, shouldContinue } from "@my-harness-desktop/shared";

/** set_goal 工具名(与 pi 扩展、渲染卡片、e2e 契约单源对齐,见 docs/design/kernel-agnostic-goal.md §5)。 */
export const SET_GOAL_TOOL = "set_goal";
/** achieve_goal 工具名。 */
export const ACHIEVE_GOAL_TOOL = "achieve_goal";

/** 驱动依赖的中性宿主面:只订阅事件流 + 发一条消息,不感知内核身份。 */
export interface GoalDriverHost {
  /** 订阅激活会话的中性事件流,返回取消函数。 */
  onEvent(cb: (event: SessionEvent) => void): () => void;
  /** 发一条用户消息(续跑提示),resolve 只代表内核接受。 */
  prompt(text: string): Promise<void>;
}

/** 续跑提示文案:目标 + 轮次 + 指令。这是 goal 机制的续跑契约(与 DSH goal-round-driver 的 <goal_round> 同语义)。 */
export function renderContinuationPrompt(objective: string, round: number, maxRounds: number): string {
  return [
    "<goal_round>",
    `Objective: ${JSON.stringify(objective)}`,
    `Round: ${round}/${maxRounds}`,
    "",
    "Continue working toward the objective in this same session. Treat the current workspace, "
    + "tool results, and durable session state as authoritative; inspect them instead of assuming "
    + "earlier narration is still current. Make concrete progress and verify the result. When the "
    + "whole objective is achieved, call the achieve_goal tool. If it is not yet achieved, keep "
    + "working and the goal will be continued on the next round.",
    "</goal_round>",
  ].join("\n");
}

/** 从 toolCallStart 事件宽松读取工具名(中性契约是 toolName;pi 透传、dsh 映射为 toolName,防御 name 兜底)。 */
function toolNameOf(event: SessionEvent): string | undefined {
  const e = event as { toolName?: unknown; name?: unknown };
  return typeof e.toolName === "string" ? e.toolName : typeof e.name === "string" ? e.name : undefined;
}

/** 从 toolCallStart 事件宽松读取工具入参(中性契约是 args;防御 input/arguments 兜底——不同内核/版本字段名漂移)。 */
function argsOf(event: SessionEvent): unknown {
  const e = event as { args?: unknown; input?: unknown; arguments?: unknown };
  return e.args ?? e.input ?? e.arguments;
}

/**
 * 同会话目标续跑驱动。跟踪激活会话的「当前目标」,在回合收敛时注入续跑提示。
 * 单目标模型(与用户心智一致):一次一个 goal,set_goal 覆盖旧的、achieve_goal 终结。
 */
export class GoalDriver {
  private state: GoalState | undefined;
  private inflight = false;
  private uninstall: (() => void) | undefined;

  constructor(private readonly host: GoalDriverHost) {}

  /** 安装事件订阅,返回取消函数(幂等取消)。 */
  install(): () => void {
    this.uninstall = this.host.onEvent((event) => this.handle(event));
    return () => { this.uninstall?.(); this.uninstall = undefined; };
  }

  /** 当前目标(测试/检查用)。 */
  getState(): GoalState | undefined {
    return this.state;
  }

  private handle(event: SessionEvent): void {
    if (event.type === "toolCallStart") {
      const name = toolNameOf(event);
      if (name === SET_GOAL_TOOL) this.onSetGoal(argsOf(event));
      else if (name === ACHIEVE_GOAL_TOOL) this.onAchieve();
      return;
    }
    if (event.type === "agentSettled") {
      void this.maybeContinue();
    }
  }

  private onSetGoal(args: unknown): void {
    const request = parseSetGoalArgs(args);
    if (request === null) return; // 畸形入参:静默忽略,不污染状态机
    try {
      this.state = createGoal(request);
    } catch (err) {
      console.error("[goal-driver] set_goal 入参非法,已忽略:", err);
    }
  }

  private onAchieve(): void {
    if (this.state === undefined) return;
    this.state = achieveGoal(this.state);
  }

  /** 回合收敛时判定是否续跑。inflight 护栏防同帧重入(agentEnd/agentSettled 双发只取后者,此处再兜一层)。 */
  private async maybeContinue(): Promise<void> {
    const state = this.state;
    if (state === undefined || !shouldContinue(state)) return;
    if (this.inflight) return;
    this.inflight = true;
    try {
      const round = state.round + 1;
      this.state = { ...state, round };
      await this.host.prompt(renderContinuationPrompt(state.objective, round, state.maxRounds));
    } catch (err) {
      // 发送失败(会话未启动/进程退):目标保持 active,round 已扣——保守不回滚,避免同帧风暴。
      console.error("[goal-driver] 续跑发送失败:", err);
    } finally {
      this.inflight = false;
    }
  }
}
