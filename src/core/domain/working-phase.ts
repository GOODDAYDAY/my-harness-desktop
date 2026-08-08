// 圆心:会话工作阶段状态 —— domain/working-phase.ts,零外部依赖。
//
// 依据 docs/design/session-working-phase.md。WorkingPhase 与 SessionState.isStreaming 同级:
// 都是"会话此刻在干嘛"的中性语义,phase 是粒度升级版。跨插件共享的中性契约只在圆心定义一次
// (timeline 底部指示与 sessions-list 行图标共用,谁都不许本地再写一份)。
//
// 两个投影服务两类消费端:
//   - phaseFromView(快照式):有完整消息数组的活跃会话消费端(timeline)。
//   - advancePhase(增量式):只有事件流、没有完整消息的消费端(sessions-list 对后台会话)。
// 共享 phaseFromMessage 的消息内容 → 阶段映射,优先级判定只有一份实现,两投影不会漂移。

import type { NeutralMessage, SessionEvent } from "./events/session-state";
import { thinkingBlocksOf, toolCallsOf } from "./events/session-state";

/** 会话工作阶段:7 值 = 4 内容推导 + 2 事件覆盖态 + 1 idle 基线(见设计文档 §1.1)。 */
export type WorkingPhase =
  /** 不工作:agentSettled 后,或进程未起。 */
  | "idle"
  /** 请求已发出,等底座首 token(agentStart 后空窗)。 */
  | "requesting"
  /** 思考链流式展开中。 */
  | "thinking"
  /** 工具调用执行中(toolCall 块 state=pending/running)。 */
  | "toolExecuting"
  /** 正文文本流式输出中。 */
  | "outputting"
  /** 自动重试退避等待中(autoRetryStart 后)。 */
  | "retrying"
  /** 上下文压缩进行中。 */
  | "compacting";

/** 快照式推导的覆盖态输入(retrying/compacting 由调用方订阅事件维护后传入,设计文档 §2.4)。 */
export interface PhaseOverlay {
  retrying?: boolean;
  compacting?: boolean;
}

/** 消息内容块 → 阶段(两个投影共享的优先级判定,契约单源)。
 *  有 state∈{pending,running} 的 toolCall 块 → 工具执行中(pending 也算:工具已开始、结果未回);
 *  否则有 text 块 → 输出中;否则有 thinking 块 → 思考中;
 *  否则 → 请求中(空 content 或只有未知/已完成块,保守视为模型在处理)。
 *  优先级是事实陈述:工具执行时 AI 在等结果,思考与输出都停着;
 *  text 优先于 thinking:一条消息的 content 里 thinking 块往往保留到最后(已定型),
 *  "已经出可见文本"比"曾有思考块"更接近此刻在干嘛。 */
export function phaseFromMessage(content: unknown): WorkingPhase {
  const toolCalls = toolCallsOf(content);
  if (toolCalls.some((t) => t.state === "pending" || t.state === "running")) return "toolExecuting";
  if (contentHasText(content)) return "outputting";
  if (thinkingBlocksOf(content).length > 0) return "thinking";
  return "requesting";
}

/** 内容是否含可见文本块:字符串内容原样算;块数组找 type==="text" 且非空。 */
function contentHasText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    if (typeof b !== "object" || b === null) return false;
    const block = b as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
  });
}

/** 快照式推导(设计文档 §1.2):活跃会话消费端(timeline)用。
 *  组合逻辑:覆盖态优先 → 不流式 → idle → 末条 pending 消息定阶段 → 无 pending → requesting。
 *  "末条消息"必须限定 pending——上一轮已定稿的消息(pending=false)不算,
 *  否则第二轮开始时会误报上一轮的 outputting。 */
export function phaseFromView(
  messages: NeutralMessage[],
  streaming: boolean,
  overlay?: PhaseOverlay,
): WorkingPhase {
  if (overlay?.retrying) return "retrying";
  if (overlay?.compacting) return "compacting";
  if (!streaming) return "idle";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.pending === true) {
      return phaseFromMessage(m.content);
    }
  }
  // streaming 但无 pending 消息:agentStart 后空窗、或两轮之间。
  return "requesting";
}

/** 增量式推导(设计文档 §1.2 转移表):只有事件流、没有完整消息的消费端(sessions-list 对后台会话)用。
 *  每个非终态转移都带"可被后续事件纠正"的语义,agentSettled/agentEnd 是权威归零——
 *  这是增量状态机只有事件流、没有完整视图的固有属性:粗粒度概览 + 权威终态自纠正。 */
export function advancePhase(prev: WorkingPhase, event: SessionEvent): WorkingPhase {
  switch (event.type) {
    case "agentStart":
      return "requesting";
    case "messageStart":
    case "messageUpdate":
      // messageStart 触发时刻 content 通常只含首个内容块,按它定阶段(后台粒度,见设计文档 §4.2)。
      return phaseFromMessage((event as { message?: NeutralMessage }).message?.content);
    case "messageEnd":
      // 一条消息定稿;AI 进思考下一步;agentSettled 随后纠正。
      return "requesting";
    case "entryAppended":
      // 落盘回执,不影响阶段。
      return prev;
    case "toolCallStart":
      return "toolExecuting";
    case "toolCallEnd":
      // 工具结束,AI 思考下一步;并行工具保守,后续事件纠正。
      return "requesting";
    case "autoRetryStart":
      return "retrying";
    case "autoRetryEnd":
      // success=true:恢复生成,收尾交后续事件;false/缺席:重试终结。
      return (event as { success?: boolean }).success === true ? prev : "idle";
    case "compactionStart":
      return "compacting";
    case "compactionEnd":
      // 覆盖态解除,回轮内默认;agentSettled 纠正。
      return "requesting";
    case "agentEnd":
    case "agentSettled":
      // agentEnd 与 agentSettled 底座同帧双发、机制等价(设计文档 §1.3)。
      return "idle";
    default:
      return prev;
  }
}
