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
// 流式:token 级增量组装成 messageStart/messageUpdate,由下方 createDshEventTranslator
// 维护跨事件状态(纯函数 translateDshEvent 做不了,需按 (turn,step) 缓冲)。增量有两种载体,
// 都必须接(漏掉批式 = 思考过程攒到最后一次性吐出、占位空窗长时间显示空消息,根因):
//   ① assistant/chunk 的 chunk.type = text-delta / reasoning-delta(单条增量);
//   ② 顶层批式事件 reasoning-chunks / text-chunks(data.texts 增量数组,多数 token 走这条)。
// 流式事件携带事件时间戳(中性域 timestamp → renderer startedAt),思考计时实时可见。
// chunk 的 finish-error 仍是模型请求失败信号,翻译成带 error 的 messageEnd,避免错误被吞。
import type { SessionEvent } from "@my-harness-desktop/shared";
import { DSH_METHODS } from "../protocol/dsh-methods";

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

    // 回合级失败显形(§7.6 显式降级,不静默):turn/end reason=error 时(如会话上回合异常
    // 留有 pending、内核运行时报错),补一个带 error 的 messageEnd——与 assistant/chunk
    // finish-error 同款载体,时间线据此渲染错误气泡。此前只发 agentSettled(reason),
    // 错误消息被吞:用户看到「消息发出、无回复、无报错」,再发也静默失败(根因)。
    // 返回数组语义由 createDshEventTranslator 承担,这里仍是单事件;组合见下方 stateful 层。

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
  /** 回合开始的计时锚(首个增量的事件时间):只随 messageStart 下发一次,messageUpdate 不再带。 */
  anchorTs?: number;
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

  /** 取缓冲(无则建);把增量累进去,首增量发 messageStart、后续 messageUpdate。
   *  时间戳只锚在 messageStart(首个增量的事件时间 = 回合开始):renderer 的 withStreamTiming
   *  把流式期 timestamp 挪成 startedAt,messageUpdate 若再带最新 chunk 时间,startedAt 会被
   *  每次更新持续前移 → 思考计时反复归零而非增长(「计时不增长/思考时间乱跳」的根因)。
   *  messageUpdate 因此不带 timestamp,startedAt 由 messageStart 锚定、后续不再动。 */
  const pushDelta = (key: string, kind: "text" | "thinking", delta: string, ts: unknown): SessionEvent[] => {
    if (!delta) return [];
    let buf = streams.get(key);
    if (!buf) {
      buf = { id: `dsh-stream-${key.replace(":", "-")}`, text: "", thinking: "", started: false, anchorTs: typeof ts === "number" ? ts : undefined };
      streams.set(key, buf);
    }
    if (kind === "text") buf.text += delta;
    else buf.thinking += delta;
    const content = buildStreamContent(buf);
    if (!buf.started) {
      buf.started = true;
      const msg = { role: "assistant" as const, id: buf.id, content, ...(buf.anchorTs !== undefined ? { timestamp: buf.anchorTs } : {}) };
      return [{ type: "messageStart", message: msg }];
    }
    // 不带 timestamp:startedAt 由 messageStart 锚定,更新只推进内容不挪计时。
    return [{ type: "messageUpdate", message: { role: "assistant" as const, id: buf.id, content } }];
  };

  return (event: unknown): SessionEvent[] => {
    if (!event || typeof event !== "object") return [];
    const e = event as Record<string, unknown>;
    const d = (e.data ?? e) as Record<string, unknown>;
    const key = `${String(d.turn ?? "")}:${String(d.step ?? "")}`;

    // 批式增量载体(多数 token 走这条;漏接 = 流式失效,根因):
    //   { type: "reasoning-chunks" | "text-chunks", time0, data: { turn, step, index, dt, texts[] } }
    if (e.type === "reasoning-chunks" || e.type === "text-chunks") {
      const texts = Array.isArray(d.texts) ? d.texts : [];
      const delta = texts.filter((t) => typeof t === "string").join("");
      return pushDelta(key, e.type === "text-chunks" ? "text" : "thinking", delta, e.time0 ?? e.time);
    }

    if (e.type === "assistant/chunk") {
      const chunk = (d.chunk ?? {}) as Record<string, unknown>;
      // 文本/思考增量(单条载体):组装进缓冲,首增量发 messageStart,后续发 messageUpdate。
      if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
        const delta = typeof chunk.text === "string" ? chunk.text : "";
        return pushDelta(key, chunk.type === "text-delta" ? "text" : "thinking", delta, e.time);
      }
      // block-end:该块的权威全文——校正缓冲(增量事件若有合批/丢失,累积值可能短于全文),
      // 只补不缩(全文更短说明是旧块,不动)。校正后推一次更新,界面与终稿对齐。
      if (chunk.type === "block-end") {
        const block = (chunk.block ?? {}) as Record<string, unknown>;
        const full = typeof block.text === "string" ? block.text : "";
        const buf = streams.get(key);
        if (buf && full) {
          let corrected = false;
          if (block.type === "text" && full.length > buf.text.length) { buf.text = full; corrected = true; }
          if (block.type === "reasoning" && full.length > buf.thinking.length) { buf.thinking = full; corrected = true; }
          if (corrected && buf.started) {
            // 校正仍是 messageUpdate:不带 timestamp,不挪 startedAt(与 pushDelta 同纪律)。
            return [{ type: "messageUpdate", message: { role: "assistant" as const, id: buf.id, content: buildStreamContent(buf) } }];
          }
        }
        return [];
      }
      // finish:流式结束。finish-error 的 messageEnd 仍由 translateDshEvent 产出(成功则静默)。
      // 成功时「不」清缓冲——assistant/message 随后到达,要读缓冲的 anchorTs 落 startedAt
      // (思考时长持久化);若在此清掉,anchor 丢失,startedAt 永不落盘(根因)。error 时无后续
      // assistant/message,清缓冲防泄漏。
      if (chunk.type === "finish") {
        const stateless = translateDshEvent(event);
        if (stateless) {
          streams.delete(key);
          return [stateless];
        }
        return [];
      }
      return [];
    }

    // assistant/message:最终完整消息(真实 id + 全量 content)→ messageEnd,清流式缓冲。
    if (e.type === "assistant/message") {
      const buf = streams.get(key);
      streams.delete(key);
      const stateless = translateDshEvent(event);
      if (!stateless) return [];
      // 持久化思考时长(§需求「思考时间要持久化」):把回合开始的计时锚写进 messageEnd 的
      // message.timestamp。中立层 sessionEntryToNeutral 把 message.timestamp 读成 startedAt、
      // entry.timestamp(下方 withNeutralEntry 用事件 time)读成完成时间——重开会话后
      // 「完成-开始」的思考时长仍可算,不靠内存。error 终态不补(无有效内容可锚)。
      if (buf?.anchorTs !== undefined && stateless.type === "messageEnd") {
        const sm = (stateless as { message?: Record<string, unknown> }).message;
        if (sm && !sm.error) sm.timestamp = buf.anchorTs;
      }
      return withNeutralEntry(e, stateless);
    }

    // turn/end reason=error:agentSettled 之外补带 error 的 messageEnd,把真实失败原因
    // (如「会话已有 pending 回合」/内核运行时错误)显形到时间线,不静默(§7.6 显式降级)。
    if (e.type === "turn/end") {
      const reason = (d.reason ?? {}) as Record<string, unknown>;
      const stateless = translateDshEvent(event);
      if (stateless && reason.kind === "error") {
        const err = (reason.error ?? {}) as Record<string, unknown>;
        const message = typeof err.message === "string" && err.message ? err.message : "turn ended with error";
        return [stateless, { type: "messageEnd", message: { role: "assistant", error: true, errorMessage: message, content: [] } }];
      }
      return stateless ? [stateless] : [];
    }

    const stateless = translateDshEvent(event);
    return stateless ? withNeutralEntry(e, stateless) : [];
  };
}

/** 中立层条目补面(§7.6 适配器翻译):壳的中立层上行同步(syncNeutralEntry)只认
 *  entryAppended(pi entry 形状 type=message + message)——dsh 此前无此面,assistant
 *  回复从不进中立层:重开会话缺回复、列表 lastMessage 停在用户语、会话流不完整(根因)。
 *  补面:消息终态时按同一语义多投一个 entryAppended,pi/dsh 经同一条路收敛进中立层。
 *  仅带权威 id 的终态消息投影(无 id 无法在中立层锚定);error 终态不落条目(不伪造内容)。 */
function withNeutralEntry(raw: Record<string, unknown>, stateless: SessionEvent): SessionEvent[] {
  if (stateless.type !== "messageEnd") return [stateless];
  const msg = (stateless as { message?: Record<string, unknown> }).message;
  if (!msg || msg.error) return [stateless];
  const id = typeof msg.id === "string" ? msg.id : undefined;
  if (!id) return [stateless];
  const time = raw.time;
  const timestamp = typeof time === "string" || typeof time === "number" ? time : undefined;
  return [
    stateless,
    { type: "entryAppended", entry: { type: "message", id, ...(timestamp !== undefined ? { timestamp } : {}), message: msg } },
  ];
}
