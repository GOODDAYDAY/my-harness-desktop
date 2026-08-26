// dsh 事件 → 中性事件翻译(§4.3 映射表的第二刀:按语义对齐 pi 的 agent/turn)。
//
// 依据 docs/design/base-interface-lineage.md §4.3 + dsh-session 的 SessionEventMap 实型:
// dsh 的「turn」是粗粒度一整轮执行(≈ pi 的 agent loop),「step」是一次模型调用 + 它请求的
// 工具执行(≈ pi 的 turn)。这里按语义对齐成同一套中性事件:
//   turn/start → agentStart、turn/end → agentSettled、step/start → stepStart、step/end → stepEnd。
// 这样 pi/dsh 吐给壳子的中性事件同一套,切内核透明(notifier 依赖 agentSettled 即内核无关)。
// 注:中性 stepStart/stepEnd(单次模型调用)此前误命名为 turnStart/turnEnd,与"回合"撞名,已纠正。
//
// dsh session 事件的外壳是 { type, seq, time, data, surfaceOp? }——真正的 payload 统一在
// data 字段下(user/message 的 id/content、assistant/message 的 message、tool/call 的
// callId/name/arguments 都在 data 里)。读字段必须从 data 读,不能从外壳顶层读。
//
// 已接生命周期类事件(拉平 pi/dsh 状态面):compaction/start+end→compactionStart/End、
// llm/retry→autoRetryStart、session/title→sessionInfoChanged(sessionName)。
// 丢弃(log-only、中性域无对应):todo/write、request/header、request/context、session/end-seed 等。
//
// 流式:assistant/chunk 的 token 级增量(text-delta/reasoning-delta)组装成
// messageStart/messageUpdate,由下方 createDshEventTranslator 维护跨事件状态(纯函数
// translateDshEvent 做不了,需按 (turn,step) 缓冲)。chunk 的 finish-error 仍是模型请求失败
// 信号,翻译成带 error 的 messageEnd,避免错误被吞、测试只见 "no response"。
import type { SessionEvent } from "@my-harness-desktop/shared";
import { DSH_METHODS } from "./dsh-methods";

/** dsh 事件 → 中性事件;无对应返回 null(调用方丢弃)。 */
export function translateDshEvent(event: unknown): SessionEvent | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  // payload 在 data 字段下;对无 data 的平铺形状(单测旧形状)回落 e 自身,兼容两者。
  const d = (e.data ?? e) as Record<string, unknown>;
  switch (e.type) {
    // 回合边界:dsh 的 turn ≈ pi 的 agent loop,故映射 agentStart/agentSettled(非 turnStart/turnEnd)。
    case "turn/start":
      return { type: "agentStart" };
    case "turn/end": {
      // 把 turn/end reason 带进中性流(不再丢弃):「继续执行」入口据此判断是否异常停机。
      const reason = (d.reason ?? {}) as Record<string, unknown>;
      return { type: "agentSettled", ...(typeof reason.kind === "string" ? { reason: reason.kind } : {}) };
    }

    // 单次模型调用边界:dsh 的 step = one model call + 其工具执行 ≈ pi 的 turn。
    case "step/start":
      return { type: "stepStart" };
    case "step/end":
      return { type: "stepEnd" };

    // user/message:payload 即 UserMessage 本身(id/role/content 在 data 顶层)。
    // 但 dsh 运行时把系统上下文(agent-instructions / skill-catalog 等)也经 user/message
    // 注入会话——这些不是用户发的消息,只在 source.kind==="user" 时翻译,否则丢弃,
    // 避免 CLAUDE.md / 技能清单等巨型系统内容冒充用户气泡污染会话流(根因)。
    // source 缺失(旧平铺形状)按 user 兼容,不误伤。
    case "user/message": {
      const source = (d.source ?? {}) as Record<string, unknown>;
      if (source.kind !== undefined && source.kind !== "user") return null;
      const id = typeof d.id === "string" ? d.id : undefined;
      return { type: "messageEnd", message: { role: "user", content: normalizeContent(d.content), id } };
    }

    // assistant/message:AssistantMessage 包在 data.message 字段里;usage 一并映射,
    // 否则壳的 turn/tps 累计(靠 messageEnd.usage)对 dsh 恒 0。
    // usage 在 data.usage(与 message 平级),不在 data.message 里——读 message.usage 恒丢(根因)。
    case "assistant/message": {
      const m = (d.message ?? {}) as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : undefined;
      const usage = mapDshUsage(d.usage ?? m.usage);
      return { type: "messageEnd", message: { role: "assistant", content: normalizeContent(m.content), id, ...(usage ? { usage } : {}) } };
    }

    // assistant/chunk:token 级流式不接;只接 finish-error(模型请求失败的信号),
    // 翻译成带 error 的 messageEnd,把真实失败原因(如 MISSING_CREDENTIAL)带出去。
    case "assistant/chunk": {
      const chunk = (d.chunk ?? {}) as Record<string, unknown>;
      if (chunk.type !== "finish") return null;
      const reason = (chunk.reason ?? {}) as Record<string, unknown>;
      if (reason.kind !== "error") return null;
      const failure = (reason.failure ?? {}) as Record<string, unknown>;
      const message = typeof failure.message === "string" && failure.message
        ? failure.message
        : "model request failed";
      return { type: "messageEnd", message: { role: "assistant", error: true, errorMessage: message, content: [] } };
    }

    // tool/call:callId/name/arguments(arguments 是模型产出的 JSON 字符串,解析成 args 对象)。
    case "tool/call": {
      return {
        type: "toolCallStart",
        toolCallId: String(d.callId ?? ""),
        toolName: String(d.name ?? "tool"),
        args: parseArgs(d.arguments),
      };
    }

    // tool/result:data.message.content[0] 是 ToolResultBlock(toolCallId/content/isError)。
    case "tool/result": {
      const m = (d.message ?? {}) as { content?: unknown[] };
      const block = (m.content?.[0] ?? {}) as Record<string, unknown>;
      return {
        type: "toolCallEnd",
        toolCallId: String(block.toolCallId ?? ""),
        result: block.content,
        isError: block.isError === true || d.error != null,
      };
    }

    // 压缩生命周期(compaction-basic 插件):compaction/start + compaction/end。
    // 中性域 compactionStart/End 驱动壳的 isCompacting(composer 覆盖态),pi 侧 compaction_start/end 同款。
    case "compaction/start":
      return { type: "compactionStart" };
    case "compaction/end":
      return { type: "compactionEnd" };

    // provider 路由重试前落盘(llm-retry 插件)→ autoRetryStart:第 retry 次重试等待前。
    // attempt/maxAttempts/delayMs/errorMessage 对齐 pi 的 auto_retry_start 字段;mode='always'
    // 无 maxRetries 上限,则不带 maxAttempts。
    case DSH_METHODS.llmRetry: {
      const failure = (d.failure ?? {}) as Record<string, unknown>;
      const errorMessage = typeof failure.message === "string" && failure.message ? failure.message : undefined;
      const retry = typeof d.retry === "number" ? d.retry : undefined;
      const maxRetries = typeof d.maxRetries === "number" ? d.maxRetries : undefined;
      const delayMs = typeof d.delayMs === "number" ? d.delayMs : undefined;
      return {
        type: "autoRetryStart",
        ...(retry !== undefined ? { attempt: retry } : {}),
        ...(maxRetries !== undefined ? { maxAttempts: maxRetries } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      };
    }

    // 会话标题快照(session-title 插件,latest-wins)→ sessionInfoChanged(sessionName)。
    // 中性域 sessionName 是壳渲染会话名的唯一来源,pi 侧 session_info_changed 同款。
    case DSH_METHODS.sessionTitle: {
      const title = typeof d.title === "string" && d.title.trim() ? d.title.trim() : undefined;
      return title ? { type: "sessionInfoChanged", sessionName: title } : null;
    }

    default:
      return null;
  }
}

/** toolCall.arguments 是模型产出的 JSON 字符串,解析成对象;解析失败原样返回字符串(不吞参数)。 */
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** dsh TokenUsage(inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens)→ 中性 usage 形状
 *  (input/output/cacheRead/cacheWrite/cost/totalTokens,messageUsageOf 契约单源读取)。
 *  dsh 无 cost 口径,置 0;totalTokens = 四项和。无/非法 usage 返回 undefined(调用方不带该字段)。 */
function mapDshUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  // 没有任何 token 字段视为无 usage(不伪造全零值;data.usage 常为 {} 占位)。
  if (u.inputTokens == null && u.outputTokens == null && u.cacheReadTokens == null && u.cacheWriteTokens == null) {
    return undefined;
  }
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = n(u.inputTokens);
  const output = n(u.outputTokens);
  const cacheRead = n(u.cacheReadTokens);
  const cacheWrite = n(u.cacheWriteTokens);
  return { input, output, cacheRead, cacheWrite, cost: 0, totalTokens: input + output + cacheRead + cacheWrite };
}

/** dsh ContentBlock 块类型 → pi 中性块类型:tool-call→toolCall(补 args 别名)、tool-result→toolResult。
 *  文本/思考块两侧同名,原样透传;未知块不动(中性域兜底渲染原始 JSON)。 */
function normalizeContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "tool-call":
        return { ...b, type: "toolCall", args: parseArgs(b.arguments) };
      case "tool-result":
        return { ...b, type: "toolResult" };
      // dsh 思考块叫 reasoning,中性域叫 thinking——不归一则 thinkingBlocksOf 过滤
      // type==="thinking" 落空,整段思考链在会话流里静默消失(根因)。
      case "reasoning":
        return { type: "thinking", thinking: typeof b.text === "string" ? b.text : String(b.text ?? "") };
      default:
        return block;
    }
  });
}

// ==============================================================================================
// 流式翻译器(带跨事件状态):assistant/chunk 的 text-delta/reasoning-delta 组装成
// messageStart/messageUpdate;assistant/message 是最终完整消息 → messageEnd。
// 每 (turn, step) 一个缓冲,key = `${turn}:${step}`(dsh 的 chunk 无 message id,只能按 step 关联)。
// ==============================================================================================

/** 一个 step 的流式缓冲:合成的临时占位 id + 累计文本/思考。 */
interface DshStreamBuffer {
  /** 合成占位 id(assistant/message 到终态时被真实 id 替换,见 DshBackend 的 applyEvent 兜底)。 */
  id: string;
  /** 累计的文本增量(text-delta)。 */
  text: string;
  /** 累计的思考增量(reasoning-delta)。 */
  thinking: string;
  /** 是否已发 messageStart(首增量发 Start,后续发 Update)。 */
  started: boolean;
}

/** 把流式缓冲折成中性内容块:[thinking] 在前、[text] 在后(对齐 dsh 先思考后作答的顺序)。 */
function buildStreamContent(buf: DshStreamBuffer): unknown[] {
  const content: unknown[] = [];
  if (buf.thinking) content.push({ type: "thinking", thinking: buf.thinking });
  if (buf.text) content.push({ type: "text", text: buf.text });
  return content;
}

/**
 * 建一个带流式状态的 dsh 事件翻译器:一个 dsh 事件可能产出 0~N 个中性事件。
 * DshBackend 每会话进程持一个实例;纯函数 translateDshEvent 负责「无状态」映射,
 * 本翻译器在其上叠加「assistant/chunk 流式组装」+「assistant/message 收尾清缓冲」。
 */
export function createDshEventTranslator(): (event: unknown) => SessionEvent[] {
  const streams = new Map<string, DshStreamBuffer>();

  return (event: unknown): SessionEvent[] => {
    if (!event || typeof event !== "object") return [];
    const e = event as Record<string, unknown>;
    const d = (e.data ?? e) as Record<string, unknown>;
    const key = `${String(d.turn ?? "")}:${String(d.step ?? "")}`;

    if (e.type === "assistant/chunk") {
      const chunk = (d.chunk ?? {}) as Record<string, unknown>;
      // 文本/思考增量:组装进缓冲,首增量发 messageStart,后续发 messageUpdate。
      if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
        const delta = typeof chunk.text === "string" ? chunk.text : "";
        let buf = streams.get(key);
        if (!buf) {
          buf = { id: `dsh-stream-${String(d.turn ?? 0)}-${String(d.step ?? 0)}`, text: "", thinking: "", started: false };
          streams.set(key, buf);
        }
        if (chunk.type === "text-delta") buf.text += delta;
        else buf.thinking += delta;
        const msg = { role: "assistant" as const, id: buf.id, content: buildStreamContent(buf) };
        if (!buf.started) {
          buf.started = true;
          return [{ type: "messageStart", message: msg }];
        }
        return [{ type: "messageUpdate", message: msg }];
      }
      // finish:流式结束,清缓冲。finish-error 的 messageEnd 仍由 translateDshEvent 产出(成功则静默)。
      if (chunk.type === "finish") {
        streams.delete(key);
        const stateless = translateDshEvent(event);
        return stateless ? [stateless] : [];
      }
      return [];
    }

    // assistant/message:最终完整消息(真实 id + 全量 content)→ messageEnd,清流式缓冲。
    if (e.type === "assistant/message") {
      streams.delete(key);
      const stateless = translateDshEvent(event);
      return stateless ? [stateless] : [];
    }

    const stateless = translateDshEvent(event);
    return stateless ? [stateless] : [];
  };
}
