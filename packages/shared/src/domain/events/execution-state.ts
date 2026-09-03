// 圆心:执行态投影类型 —— 易失运行态,与内容分家(session-single-source §2.2/§3.4)。
//
// 判别标准:刷新后还在不在。在的是内容(进中立层),不在的是执行态(本文件)。
// 执行态由壳从事件流记账产出,两内核天然同口径——不需要任何内核 RPC。
// 本文件零依赖(只 import domain 内部类型),是圆心最内层的原子之一。

import type { KernelId } from "../kernel";
import type { TurnUsage } from "./session-state";

/** 在飞回复的流式缓冲:streamId 是壳按(回合,步)合成的临时身份,定稿即弃,与中立 entryId 不相干。 */
export interface StreamBufferState {
  streamId: string;
  role: string;
  /** 已组装的内容块数组(text/thinking/toolCall 中性块)。 */
  content: unknown[];
  /** 回合开始的计时锚(首个增量的事件时间)。 */
  startedAt?: number;
}

/** 在飞工具调用(toolCallStart 标记、toolCallEnd 清除)。 */
export interface InflightToolCall {
  name: string;
  args?: unknown;
  partialResult?: unknown;
}

/** 自动重试退避详情(无重试时为 null)。 */
export interface RetryState {
  attempt: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
}

/**
 * 执行态投影(每会话一份,按会话 key 键控):渲染层的视觉态数据源——
 * 光标、转圈、徽章、在飞工具卡。纯内存态,不落盘、不进中立层。
 * 生命周期三粒度:流式缓冲定稿即弃;按会话条目随会话进程同生死;应用退出全清。
 */
export interface SessionExecutionState {
  /** 回合进行中(agentStart 置位、agentSettled 清位,自动重试退避期视为忙)。 */
  busy: boolean;
  /** 压缩进行中。 */
  compacting: boolean;
  /** 重试退避详情;无重试为 null。 */
  retry: RetryState | null;
  /** 在飞回复的流式缓冲;无在飞回复为 null。 */
  streaming: StreamBufferState | null;
  /** 在飞工具调用(按 toolCallId 键控)。 */
  inflightTools: Record<string, InflightToolCall>;
  /** 发送时定下的执行模型(本条消息由哪个模型生成的实况)。 */
  effectiveModel: { provider: string; modelId: string; kernel: KernelId } | null;
  /** 本轮 token 用量(agentStart 归档清零,messageEnd 累加)。 */
  turn: TurnUsage;
  /** 上一次完成轮用量;null=尚无完成轮。 */
  lastTurn: TurnUsage | null;
  /** 输出 tokens/秒(壳自算,内核不给)。 */
  tps: number | null;
  /** 完成回合数。 */
  turns: number;
  /** 完成的单次模型调用数。 */
  steps: number;
}

/** 空执行态(新会话/进程未起)。 */
export function emptyExecutionState(): SessionExecutionState {
  return {
    busy: false,
    compacting: false,
    retry: null,
    streaming: null,
    inflightTools: {},
    effectiveModel: null,
    turn: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    lastTurn: null,
    tps: null,
    turns: 0,
    steps: 0,
  };
}
