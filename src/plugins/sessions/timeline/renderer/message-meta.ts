// message-meta.ts —— 消息时间/指标的中性纯函数(无 React、无 IO,可裸单测)。
//
// 会话流内建的时间与指标展示(§8.4 会话流自己做):把 NeutralMessage 投影成一行
// 可读的元信息——用户消息 = 发送时间,assistant 消息 = 完成时间 + 总时长(完成-开始)+
// token 用量(输入/输出)。thinking 时长是思考链块(thinking-chain-block)自己的领域,
// 不在这里重复计算(那里已经「动态增长 + 持久化」,数据源同为 startedAt/timestamp)。
import { messageUsageOf, type NeutralMessage } from "@my-harness-desktop/shared";

/** 把 epoch 毫秒时间戳格式化为 HH:MM:SS。 */
export function formatClockTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** 简洁时长(毫秒→"3.2s"/"1m5s")。 */
export function formatDurationBrief(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/** 1234 → "1.2k"(与圆心 fmtTokens 同款口径)。 */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 一行消息元信息(供 hover 展示)。返回 null = 无时间戳可展示(不假装 0)。 */
export interface MessageMeta {
  /** HH:MM:SS:user=发送时间,assistant=完成时间(圆心语义 timestamp=落盘/完成)。 */
  clock: string;
  /** assistant 专属:完成时间 - startedAt(一轮调用真实耗时,含思考+工具+生成)。 */
  duration?: string;
  /** assistant 专属:token 用量(输入/输出),无 usage 或全 0 则缺省。 */
  tokens?: { input: string; output: string };
}

/** 从单条消息投影可读元信息。无 timestamp 返回 null(旧数据/占位不展示)。 */
export function buildMessageMeta(message: NeutralMessage): MessageMeta | null {
  const ts = typeof message.timestamp === "number" ? message.timestamp : undefined;
  if (!ts) return null;
  const meta: MessageMeta = { clock: formatClockTime(ts) };
  if (message.role === "assistant") {
    if (typeof message.startedAt === "number") {
      meta.duration = formatDurationBrief(Math.max(0, ts - message.startedAt));
    }
    const usage = messageUsageOf(message);
    if (usage && (usage.tokens.input > 0 || usage.tokens.output > 0)) {
      meta.tokens = {
        input: formatTokens(usage.tokens.input),
        output: formatTokens(usage.tokens.output),
      };
    }
  }
  return meta;
}
