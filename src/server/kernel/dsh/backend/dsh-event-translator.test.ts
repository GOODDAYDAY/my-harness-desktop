// dsh 事件翻译单测:验证 dsh SessionEventMap → 中性 SessionEvent 的第一刀映射。
import { describe, it, expect } from "vitest";
import { translateDshEvent, createDshEventTranslator } from "./dsh-event-translator";

describe("translateDshEvent", () => {
  it("turn/start、turn/end → agentStart/agentSettled(回合边界)", () => {
    expect(translateDshEvent({ type: "turn/start", turn: 1 })).toEqual({ type: "agentStart" });
    expect(translateDshEvent({ type: "turn/end", turn: 1, reason: { kind: "completed" } })).toEqual({ type: "agentSettled", reason: "completed" });
    // 缺 reason 的 turn/end(旧形状)不带 reason 字段,不抛错
    expect(translateDshEvent({ type: "turn/end", turn: 1 })).toEqual({ type: "agentSettled" });
  });

  it("step/start、step/end → stepStart/stepEnd(单次模型调用边界)", () => {
    expect(translateDshEvent({ type: "step/start", turn: 1, step: 1 })).toEqual({ type: "stepStart" });
    expect(translateDshEvent({ type: "step/end", turn: 1, step: 1 })).toEqual({ type: "stepEnd" });
  });

  it("user/message → messageEnd(role user + content + id)", () => {
    const r = translateDshEvent({ type: "user/message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] });
    expect(r).toEqual({ type: "messageEnd", message: { role: "user", content: [{ type: "text", text: "hi" }], id: "u1" } });
  });

  it("assistant/message → messageEnd(role assistant)", () => {
    const r = translateDshEvent({
      type: "assistant/message",
      turn: 1,
      step: 1,
      message: { id: "a1", role: "assistant", content: [{ type: "text", text: "answer" }] },
    });
    expect(r).toEqual({ type: "messageEnd", message: { role: "assistant", content: [{ type: "text", text: "answer" }], id: "a1" } });
  });

  it("assistant/message 的 usage 映射为中性 usage 形状(inputTokens→input、cacheReadTokens→cacheRead、totalTokens=四项和)", () => {
    const r = translateDshEvent({
      type: "assistant/message",
      message: { id: "a1", role: "assistant", content: [], usage: { inputTokens: 10, outputTokens: 60, cacheReadTokens: 3, cacheWriteTokens: 2 } },
    });
    expect(r).toMatchObject({
      type: "messageEnd",
      message: { usage: { input: 10, output: 60, cacheRead: 3, cacheWrite: 2, cost: 0, totalTokens: 75 } },
    });
  });

  it("assistant/message 无 usage 时不带 usage 字段(不伪造零值)", () => {
    const r = translateDshEvent({ type: "assistant/message", message: { id: "a1", role: "assistant", content: [] } });
    expect(r).toMatchObject({ type: "messageEnd", message: { id: "a1" } });
    expect((r as { message: Record<string, unknown> }).message.usage).toBeUndefined();
  });

  it("tool/call → toolCallStart(arguments JSON 字符串解析成 args 对象)", () => {
    const r = translateDshEvent({ type: "tool/call", turn: 1, step: 1, callId: "c1", name: "bash", arguments: '{"command":"ls"}' });
    expect(r).toEqual({ type: "toolCallStart", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
  });

  it("tool/call arguments 解析失败时原样返回字符串", () => {
    const r = translateDshEvent({ type: "tool/call", callId: "c2", name: "bash", arguments: "not-json" });
    expect(r).toMatchObject({ type: "toolCallStart", args: "not-json" });
  });

  it("tool/result → toolCallEnd(result + isError)", () => {
    const r = translateDshEvent({
      type: "tool/result",
      turn: 1,
      step: 1,
      message: { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "out" }], isError: false }] },
    });
    expect(r).toEqual({ type: "toolCallEnd", toolCallId: "c1", result: [{ type: "text", text: "out" }], isError: false });
  });

  it("tool/result 带 error 时 isError=true", () => {
    const r = translateDshEvent({
      type: "tool/result",
      message: { content: [{ type: "tool-result", toolCallId: "c1", content: [] }] },
      error: { name: "E", code: "1" },
    });
    expect(r).toMatchObject({ type: "toolCallEnd", isError: true });
  });

  it("assistant/message 的 content 块类型归一:tool-call→toolCall(补 args)、tool-result→toolResult", () => {
    const r = translateDshEvent({
      type: "assistant/message",
      message: {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' },
          { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "out" }] },
        ],
      },
    });
    expect(r).toEqual({
      type: "messageEnd",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "toolCall", id: "c1", name: "bash", arguments: '{"command":"ls"}', args: { command: "ls" } },
          { type: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "out" }] },
        ],
        id: "a1",
      },
    });
  });

  it("assistant/message 的 reasoning 块归一为 thinking(不归一会话流丢整段思考链)", () => {
    const r = translateDshEvent({
      type: "assistant/message",
      data: { message: { id: "a1", role: "assistant", content: [{ type: "reasoning", text: "先想一下" }] } },
    });
    expect(r).toEqual({
      type: "messageEnd",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "先想一下" }], id: "a1" },
    });
  });

  it("真实外壳下 usage 在 data.usage(与 message 平级),不在 data.message 里", () => {
    const r = translateDshEvent({
      type: "assistant/message", seq: 46, time: 1,
      data: {
        turn: 1, step: 1,
        message: { id: "a1", role: "assistant", content: [] },
        usage: { inputTokens: 10, outputTokens: 60, cacheReadTokens: 3, cacheWriteTokens: 2 },
      },
    });
    expect(r).toMatchObject({
      type: "messageEnd",
      message: { usage: { input: 10, output: 60, cacheRead: 3, cacheWrite: 2, cost: 0, totalTokens: 75 } },
    });
  });

  it("user/message 只翻译 source.kind==='user';系统注入(agent-instructions/skill-catalog)丢弃", () => {
    const real = translateDshEvent({
      type: "user/message", seq: 7, time: 1,
      data: { id: "u1", role: "user", content: [{ type: "text", text: "ping" }], source: { kind: "user" } },
    });
    expect(real).toEqual({ type: "messageEnd", message: { role: "user", content: [{ type: "text", text: "ping" }], id: "u1" } });

    expect(translateDshEvent({
      type: "user/message", seq: 8, time: 1,
      data: { id: "s1", role: "user", content: [{ type: "text", text: "CLAUDE.md..." }], source: { kind: "agent-instructions", form: "instructions" } },
    })).toBeNull();

    expect(translateDshEvent({
      type: "user/message", seq: 9, time: 1,
      data: { id: "s2", role: "user", content: [{ type: "text", text: "skills..." }], source: { kind: "skill-catalog", form: "catalog" } },
    })).toBeNull();
  });

  it("todo/write、assistant/chunk(非 finish)、session/end-seed 等中性域无对应 → null", () => {
    expect(translateDshEvent({ type: "todo/write", todos: [] })).toBeNull();
    expect(translateDshEvent({ type: "assistant/chunk", turn: 1, step: 1, chunk: {} })).toBeNull();
    expect(translateDshEvent({ type: "session/end-seed" })).toBeNull();
  });

  it("真实外壳形状:payload 在 data 字段下(user/message、assistant/message)", () => {
    const u = translateDshEvent({
      type: "user/message", seq: 4, time: 1,
      data: { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
      surfaceOp: "append",
    });
    expect(u).toEqual({ type: "messageEnd", message: { role: "user", content: [{ type: "text", text: "hi" }], id: "u1" } });

    const a = translateDshEvent({
      type: "assistant/message", seq: 46, time: 1,
      data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", content: [{ type: "text", text: "answer" }] }, usage: {} },
      sourceEventSeqs: [45], surfaceOp: "append",
    });
    expect(a).toEqual({ type: "messageEnd", message: { role: "assistant", content: [{ type: "text", text: "answer" }], id: "a1" } });
  });

  it("assistant/chunk 的 finish-error → messageEnd 带 error(不吞失败原因)", () => {
    const r = translateDshEvent({
      type: "assistant/chunk", seq: 5, time: 1,
      data: { turn: 1, step: 1, chunk: { type: "finish", reason: { kind: "error", failure: { message: "llm-pi-ai: no credential ... US_NEW_API_KEY", code: "MISSING_CREDENTIAL" } } } },
    });
    expect(r).toMatchObject({ type: "messageEnd", message: { role: "assistant", error: true } });
    expect((r as { message?: { errorMessage?: string } }).message?.errorMessage).toContain("US_NEW_API_KEY");
  });

  it("compaction/start、compaction/end → compactionStart/compactionEnd(压缩生命周期)", () => {
    expect(translateDshEvent({ type: "compaction/start", data: { compactionId: "cp1", turn: 1 } }))
      .toEqual({ type: "compactionStart" });
    expect(translateDshEvent({ type: "compaction/end", data: { compactionId: "cp1", turn: 1 } }))
      .toEqual({ type: "compactionEnd" });
  });

  it("llm/retry → autoRetryStart(attempt/maxAttempts/delayMs/errorMessage 对齐 pi auto_retry_start)", () => {
    const r = translateDshEvent({
      type: "llm/retry",
      data: { retryId: "r1", turn: 1, step: 1, provider: "us-new", mode: "normal", policyKey: "k", retry: 2, maxRetries: 3, delayMs: 400, failure: { message: "boom" } },
    });
    expect(r).toEqual({ type: "autoRetryStart", attempt: 2, maxAttempts: 3, delayMs: 400, errorMessage: "boom" });
  });

  it("llm/retry mode=always 无 maxRetries 时不带 maxAttempts", () => {
    const r = translateDshEvent({
      type: "llm/retry",
      data: { retry: 1, mode: "always", delayMs: 100, failure: { message: "x" } },
    });
    expect(r).toMatchObject({ type: "autoRetryStart", attempt: 1 });
    expect((r as { maxAttempts?: number }).maxAttempts).toBeUndefined();
  });

  it("session/title → sessionInfoChanged(sessionName),空标题回 null", () => {
    expect(translateDshEvent({ type: "session/title", data: { title: "  会话标题  " } }))
      .toEqual({ type: "sessionInfoChanged", sessionName: "会话标题" });
    expect(translateDshEvent({ type: "session/title", data: { title: "  " } })).toBeNull();
  });
});

describe("createDshEventTranslator(带流式状态)", () => {
  const chunkEvent = (turn: number, step: number, chunk: unknown): unknown => ({
    type: "assistant/chunk", seq: 1, time: 1, data: { turn, step, chunk },
  });

  it("text-delta 首增量 → messageStart,后续 → messageUpdate(同一步内组装)", () => {
    const t = createDshEventTranslator();
    const first = t(chunkEvent(1, 1, { type: "text-delta", index: 0, text: "Hello" }));
    expect(first).toEqual([
      // timestamp=事件时间仅随 messageStart 下发:渲染层挪作 startedAt 计时锚。
      { type: "messageStart", message: { role: "assistant", id: "dsh-stream-1-1", content: [{ type: "text", text: "Hello" }], timestamp: 1 } },
    ]);

    const second = t(chunkEvent(1, 1, { type: "text-delta", index: 0, text: " world" }));
    // messageUpdate 不带 timestamp:startedAt 由 messageStart 锚定,更新只推进内容不挪计时。
    expect(second).toEqual([
      { type: "messageUpdate", message: { role: "assistant", id: "dsh-stream-1-1", content: [{ type: "text", text: "Hello world" }] } },
    ]);
  });

  it("reasoning-delta 折成 thinking 块(在 text 之前)", () => {
    const t = createDshEventTranslator();
    t(chunkEvent(1, 1, { type: "reasoning-delta", index: 0, text: "先想" }));
    const r = t(chunkEvent(1, 1, { type: "text-delta", index: 1, text: "答案" }));
    expect(r).toEqual([
      {
        type: "messageUpdate",
        message: { role: "assistant", id: "dsh-stream-1-1", content: [{ type: "thinking", thinking: "先想" }, { type: "text", text: "答案" }] },
      },
    ]);
  });

  it("计时锚只在 messageStart 下发一次,后续 messageUpdate 不带 timestamp(不挪 startedAt)", () => {
    const t = createDshEventTranslator();
    const deltaEvent = (time: number, text: string): unknown => ({
      type: "assistant/chunk", seq: 1, time, data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text } },
    });
    // 首个增量(事件时间 10)= 回合开始锚点。
    const start = t(deltaEvent(10, "想"));
    expect((start[0] as { message?: { timestamp?: number } }).message?.timestamp).toBe(10);
    // 后续增量事件时间推进到 99,但 messageUpdate 不带 timestamp——否则渲染层 withStreamTiming
    // 会把最新 chunk 时间当 startedAt 前移,思考计时反复归零而非增长(根因回归位)。
    const upd = t(deltaEvent(99, "想更多"));
    expect(upd).toEqual([
      { type: "messageUpdate", message: { role: "assistant", id: "dsh-stream-1-1", content: [{ type: "thinking", thinking: "想想更多" }] } },
    ]);
    expect((upd[0] as { message?: { timestamp?: number } }).message?.timestamp).toBeUndefined();
  });

  // 批式增量载体(真实流量里多数 token 走这条;漏接 = 流式失效、空窗期显示空消息、
  // 思考攒到最后一次性吐出——用户投诉 #4/#5 的根因回归位)。
  const batchEvent = (type: "reasoning-chunks" | "text-chunks", turn: number, step: number, texts: string[], time0 = 1): unknown => ({
    type, seq0: 1, time0, data: { turn, step, index: 0, dt: texts.map(() => 1), texts },
  });

  it("reasoning-chunks 批式 → messageStart(thinking 拼接)+ 事件时间戳(计时锚)", () => {
    const t = createDshEventTranslator();
    const r = t(batchEvent("reasoning-chunks", 1, 1, ["The", " user", " said"], 42));
    expect(r).toEqual([
      { type: "messageStart", message: { role: "assistant", id: "dsh-stream-1-1", content: [{ type: "thinking", thinking: "The user said" }], timestamp: 42 } },
    ]);
  });

  it("text-chunks 批式与单条 text-delta 共用同一缓冲(两种载体不丢不重)", () => {
    const t = createDshEventTranslator();
    t(batchEvent("text-chunks", 1, 1, ["pong", " 🏓"]));
    const r = t(chunkEvent(1, 1, { type: "text-delta", index: 1, text: " 开工" }));
    expect(r).toEqual([
      { type: "messageUpdate", message: { role: "assistant", id: "dsh-stream-1-1", content: [{ type: "text", text: "pong 🏓 开工" }] } },
    ]);
  });

  it("批式空增量不产事件(不刷无意义 update)", () => {
    const t = createDshEventTranslator();
    expect(t(batchEvent("text-chunks", 1, 1, []))).toEqual([]);
    expect(t(batchEvent("reasoning-chunks", 1, 1, ["", ""]))).toEqual([]);
  });

  it("block-end 权威全文校正缓冲:累积更短 → 补齐全文;缓冲更长 → 不缩(只补不缩)", () => {
    const t = createDshEventTranslator();
    t(chunkEvent(1, 1, { type: "text-delta", index: 0, text: "par" }));
    // 全文更长(增量丢了中间一段)→ 校正为全文并推更新(不带 timestamp,不挪计时)。
    const fixed = t(chunkEvent(1, 1, { type: "block-end", index: 0, block: { type: "text", text: "partial full" } }));
    expect(fixed).toEqual([
      { type: "messageUpdate", message: { role: "assistant", id: "dsh-stream-1-1", content: [{ type: "text", text: "partial full" }] } },
    ]);
    // 全文更短(旧块/乱序)→ 不缩、不产事件。
    expect(t(chunkEvent(1, 1, { type: "block-end", index: 0, block: { type: "text", text: "par" } }))).toEqual([]);
  });

  it("assistant/message 收尾 → messageEnd(真实 id)+ entryAppended(中立层补面),并清流式缓冲", () => {
    const t = createDshEventTranslator();
    t(chunkEvent(1, 1, { type: "text-delta", index: 0, text: "partial" }));
    const end = t({
      type: "assistant/message", seq: 2, time: 2,
      data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", content: [{ type: "text", text: "partial" }] }, usage: {} },
    });
    expect(end).toEqual([
      // message.timestamp=计时锚(回合开始):持久化后 sessionEntryToNeutral 读成 startedAt,
      // 思考时长「完成-开始」重开会话仍可算(需求「思考时间要持久化」)。
      { type: "messageEnd", message: { role: "assistant", content: [{ type: "text", text: "partial" }], id: "a1", timestamp: 1 } },
      // 中立层上行同步只认 entryAppended(pi entry 形状)——dsh 补面后回复才进中立层。
      // entry.timestamp=事件 time(完成时间),entry.message.timestamp=计时锚(开始时间)。
      { type: "entryAppended", entry: { type: "message", id: "a1", timestamp: 2, message: { role: "assistant", content: [{ type: "text", text: "partial" }], id: "a1", timestamp: 1 } } },
    ]);
    // 下一 step 复用同一翻译器,不串流(新 step 新缓冲)。
    const next = t(chunkEvent(1, 2, { type: "text-delta", index: 0, text: "new" }));
    expect(next).toEqual([
      { type: "messageStart", message: { role: "assistant", id: "dsh-stream-1-2", content: [{ type: "text", text: "new" }], timestamp: 1 } },
    ]);
  });

  it("finish-success 不产事件但保留缓冲供 assistant/message 读锚;finish-error 产 messageEnd error 且清缓冲", () => {
    const t = createDshEventTranslator();
    t(chunkEvent(1, 1, { type: "text-delta", index: 0, text: "partial" }));
    expect(t(chunkEvent(1, 1, { type: "finish", reason: { kind: "completed" } }))).toEqual([]);
    // 后续 assistant/message 到终态:缓冲未清 → 读 anchorTs 落 message.timestamp(持久化 startedAt)。
    const end = t({
      type: "assistant/message", data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", content: [{ type: "text", text: "partial" }] } },
    });
    expect(end).toEqual([
      { type: "messageEnd", message: { role: "assistant", content: [{ type: "text", text: "partial" }], id: "a1", timestamp: 1 } },
      { type: "entryAppended", entry: { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "partial" }], id: "a1", timestamp: 1 } } },
    ]);
    // finish-error:messageEnd 带 error,但不投影 entryAppended(错误终态无内容可落)。
    const err = t(chunkEvent(1, 2, { type: "finish", reason: { kind: "error", failure: { message: "boom" } } }));
    expect(err).toEqual([
      { type: "messageEnd", message: { role: "assistant", error: true, errorMessage: "boom", content: [] } },
    ]);
  });

  it("user/message(source.kind=user)→ messageEnd + entryAppended;系统注入丢弃(连条目也不落)", () => {
    const t = createDshEventTranslator();
    const u = t({
      type: "user/message", seq: 7, time: 3,
      data: { id: "u1", role: "user", content: [{ type: "text", text: "ping" }], source: { kind: "user" } },
    });
    expect(u).toEqual([
      { type: "messageEnd", message: { role: "user", content: [{ type: "text", text: "ping" }], id: "u1" } },
      { type: "entryAppended", entry: { type: "message", id: "u1", timestamp: 3, message: { role: "user", content: [{ type: "text", text: "ping" }], id: "u1" } } },
    ]);
    // 系统上下文注入不是用户消息:既不产 messageEnd 也不产条目。
    const sys = t({
      type: "user/message", seq: 8, time: 4,
      data: { id: "s1", role: "user", content: [{ type: "text", text: "CLAUDE.md..." }], source: { kind: "agent-instructions" } },
    });
    expect(sys).toEqual([]);
  });

  it("无 id 的终态消息:只产 messageEnd,不投影条目(中立层锚不定,不伪造)", () => {
    const t = createDshEventTranslator();
    const r = t({
      type: "assistant/message", seq: 9, time: 5,
      data: { turn: 1, step: 3, message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
    });
    expect(r).toEqual([
      { type: "messageEnd", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
    ]);
  });

  it("turn/end reason=error:agentSettled 之外补 messageEnd error(失败显形,不静默)", () => {
    const t = createDshEventTranslator();
    const r = t({
      type: "turn/end", seq: 10, time: 6,
      data: { turn: 1, reason: { kind: "error", error: { message: "session already has a pending turn", code: "UNKNOWN" } } },
    });
    expect(r).toEqual([
      { type: "agentSettled", reason: "error" },
      { type: "messageEnd", message: { role: "assistant", error: true, errorMessage: "session already has a pending turn", content: [] } },
    ]);
  });

  it("turn/end reason=completed:只产 agentSettled,不补错误气泡", () => {
    const t = createDshEventTranslator();
    expect(t({ type: "turn/end", seq: 11, time: 7, data: { turn: 1, reason: { kind: "completed" } } })).toEqual([
      { type: "agentSettled", reason: "completed" },
    ]);
  });
});

describe("createDshEventTranslator → 工具调用流式(此前漏接,工具卡刷新才出现)", () => {
  it("tool-call-chunks(批式 args[])→ messageStart 带 toolCall 块,args 拼回并解析", () => {
    const t = createDshEventTranslator();
    const r = t({
      type: "tool-call-chunks", seq0: 1, time0: 5,
      data: { turn: 1, step: 1, index: 0, dt: [1], id: "call_1", name: "bash", args: ["{", '"command"', ':', '"ls"', "}"] },
    });
    expect(r).toHaveLength(1);
    const msg = (r[0] as { type: string; message: { content: unknown[] } }).message;
    expect(msg.content).toEqual([
      { type: "toolCall", id: "call_1", name: "bash", args: { command: "ls" } },
    ]);
  });

  it("tool-call-delta(单条,assistant/chunk 嵌套)→ 累积 argumentsDelta 进同 id 的 toolCall 块", () => {
    const t = createDshEventTranslator();
    const chunk = (id: string, name: string, argumentsDelta: string) => ({
      type: "assistant/chunk", seq: 1, time: 1, data: { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 0, id, name, argumentsDelta } },
    });
    t(chunk("call_1", "bash", '{ "command":'));
    const r = t(chunk("call_1", "bash", ' "ls" }'));
    const msg = (r[0] as { message: { content: unknown[] } }).message;
    expect(msg.content).toEqual([
      { type: "toolCall", id: "call_1", name: "bash", args: { command: "ls" } },
    ]);
  });

  it("thinking + toolCall + text 按顺序共缓冲(思考→工具→作答)", () => {
    const t = createDshEventTranslator();
    t({ type: "reasoning-chunks", seq0: 1, time0: 1, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["想"] } });
    t({ type: "tool-call-chunks", seq0: 2, time0: 2, data: { turn: 1, step: 1, index: 1, dt: [1], id: "call_1", name: "read", args: ["{", '"path"', ':', '"/a"', "}"] } });
    const r = t({ type: "text-chunks", seq0: 3, time0: 3, data: { turn: 1, step: 1, index: 2, dt: [1], texts: ["答"] } });
    const msg = (r[0] as { message: { content: unknown[] } }).message;
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "想" },
      { type: "toolCall", id: "call_1", name: "read", args: { path: "/a" } },
      { type: "text", text: "答" },
    ]);
  });
});

describe("createDshEventTranslator: turn/end 收尾(pending 不残留,「思考中」不自旋)", () => {
  it("abort 于流式中段:遗留缓冲按 stopped=true 收尾(部分内容保留)", () => {
    const t = createDshEventTranslator();
    t({ type: "reasoning-chunks", seq0: 1, time0: 1, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["想了一半"] } });
    const out = t({ type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "aborted" } } });
    const end = out.find((e) => e.type === "messageEnd") as { message: { id?: string; stopped?: boolean; content: unknown[] } } | undefined;
    expect(end).toBeDefined();
    expect(end!.message.stopped).toBe(true);
    expect(end!.message.id).toBe("dsh-stream-1-1");
    expect(end!.message.content).toEqual([{ type: "thinking", thinking: "想了一半" }]);
    expect(out.some((e) => e.type === "agentSettled")).toBe(true);
  });

  it("abort 于任何增量之前:补空内容 stopped 终态(渲染层乐观占位据此清除)", () => {
    const t = createDshEventTranslator();
    const out = t({ type: "turn/end", seq: 1, time: 1, data: { turn: 1, reason: { kind: "aborted" } } });
    const end = out.find((e) => e.type === "messageEnd") as { message: { stopped?: boolean; content: unknown[] } } | undefined;
    expect(end).toBeDefined();
    expect(end!.message.stopped).toBe(true);
    expect(end!.message.content).toEqual([]);
  });

  it("completed 但 assistant/message 缺席(异常形态):按遗留缓冲补正常终态", () => {
    const t = createDshEventTranslator();
    t({ type: "text-chunks", seq0: 1, time0: 1, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["半截回答"] } });
    const out = t({ type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "completed" } } });
    const end = out.find((e) => e.type === "messageEnd") as { message: { id?: string; content: unknown[] } } | undefined;
    expect(end).toBeDefined();
    expect(end!.message.id).toBe("dsh-stream-1-1");
    expect(end!.message.content).toEqual([{ type: "text", text: "半截回答" }]);
  });

  it("completed 且 assistant/message 正常到达(常态):不重复补终态", () => {
    const t = createDshEventTranslator();
    t({ type: "text-chunks", seq0: 1, time0: 1, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["答"] } });
    t({ type: "assistant/message", seq: 2, time: 2, data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", content: [{ type: "text", text: "答" }] } } });
    const out = t({ type: "turn/end", seq: 3, time: 3, data: { turn: 1, reason: { kind: "completed" } } });
    expect(out.filter((e) => e.type === "messageEnd")).toHaveLength(0);
    expect(out.some((e) => e.type === "agentSettled")).toBe(true);
  });

  it("turn/end error 且有遗留缓冲:错误终态带部分内容(部分内容不丢)", () => {
    const t = createDshEventTranslator();
    t({ type: "text-chunks", seq0: 1, time0: 1, data: { turn: 2, step: 1, index: 0, dt: [1], texts: ["写了一半"] } });
    const out = t({ type: "turn/end", seq: 2, time: 2, data: { turn: 2, reason: { kind: "error", error: { message: "boom" } } } });
    const end = out.find((e) => e.type === "messageEnd") as { message: { id?: string; error?: boolean; errorMessage?: string; content: unknown[] } } | undefined;
    expect(end).toBeDefined();
    expect(end!.message.error).toBe(true);
    expect(end!.message.errorMessage).toBe("boom");
    expect(end!.message.id).toBe("dsh-stream-2-1");
    expect(end!.message.content).toEqual([{ type: "text", text: "写了一半" }]);
  });

  it("跨回合不泄漏:turn1 的缓冲不影响 turn2 的 turn/end", () => {
    const t = createDshEventTranslator();
    t({ type: "text-chunks", seq0: 1, time0: 1, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["旧"] } });
    t({ type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "aborted" } } }); // 清 turn1
    const out = t({ type: "turn/end", seq: 3, time: 3, data: { turn: 2, reason: { kind: "completed" } } });
    expect(out.filter((e) => e.type === "messageEnd")).toHaveLength(0);
  });
});

describe("createDshEventTranslator: request/header 派生模型/思考分隔线(dsh 会话流与 pi 同信息密度)", () => {
  const header = (config: Record<string, unknown>, seq = 10, time = 1000) => ({
    type: "request/header", seq, time, data: { header: { config } },
  });

  it("生效模型 ≠ 握手模型:派生 model_change 分隔线(entryAppended,与 pi 条目同形状)", () => {
    const t = createDshEventTranslator({ provider: "p", model: "a" });
    const out = t(header({ provider: "p", model: "b", maxTokens: 1000 }));
    expect(out).toHaveLength(1);
    const ev = out[0] as { type: string; entry: Record<string, unknown> };
    expect(ev.type).toBe("entryAppended");
    expect(ev.entry.type).toBe("model_change");
    expect(ev.entry.provider).toBe("p");
    expect(ev.entry.modelId).toBe("b");
    expect(typeof ev.entry.id).toBe("string");
  });

  it("生效模型 = 握手模型:不派生(重开/重spawn 不刷假分隔线)", () => {
    const t = createDshEventTranslator({ provider: "p", model: "a" });
    expect(t(header({ provider: "p", model: "a", maxTokens: 1000 }))).toHaveLength(0);
  });

  it("同配置重复请求:只在首次派生一次(每步都有 request/header,不刷屏)", () => {
    const t = createDshEventTranslator({ provider: "p", model: "a" });
    expect(t(header({ provider: "p", model: "b" }))).toHaveLength(1);
    expect(t(header({ provider: "p", model: "b" }, 11))).toHaveLength(0);
  });

  it("config 带 reasoningEffort:派生 thinking_level_change 分隔线;未带不派生", () => {
    const t = createDshEventTranslator({ provider: "p", model: "a" });
    const out = t(header({ provider: "p", model: "a", reasoningEffort: "high" }));
    expect(out).toHaveLength(1);
    const ev = out[0] as { entry: Record<string, unknown> };
    expect(ev.entry.type).toBe("thinking_level_change");
    expect(ev.entry.thinkingLevel).toBe("high");
    // 再次同值不重复
    expect(t(header({ provider: "p", model: "a", reasoningEffort: "high" }, 11))).toHaveLength(0);
  });

  it("模型与思考强度同帧变化:两条分隔线按序派生", () => {
    const t = createDshEventTranslator({ provider: "p", model: "a" });
    const out = t(header({ provider: "p", model: "b", reasoningEffort: "low" }));
    expect(out).toHaveLength(2);
    expect((out[0] as { entry: { type: string } }).entry.type).toBe("model_change");
    expect((out[1] as { entry: { type: string } }).entry.type).toBe("thinking_level_change");
  });

  it("无 config/缺字段:静默不派生(防御)", () => {
    const t = createDshEventTranslator({ provider: "p", model: "a" });
    expect(t({ type: "request/header", seq: 1, time: 1, data: {} })).toHaveLength(0);
    expect(t(header({ maxTokens: 1000 }))).toHaveLength(0);
  });
});
