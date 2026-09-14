import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// dsh 侧扩展是**纯 .mjs**（原样同步进 ~/.dsh/.my-harness-desktop-plugins/，不经 TS 构建），
// 因此没有类型声明。用 ts-expect-error 精确收口这一条，不给全仓放宽 allowJs。
// @ts-expect-error 无类型声明的内核侧插件模块（见上）
import dshRecorderUntyped from "./dsh-extension/index.mjs";
import { pairRecords, parseLogText } from "./core/log-model";

const dshRecorder = dshRecorderUntyped as {
  apply: (ctx: unknown) => void;
};

/**
 * llm-recorder 的 **dsh 侧** 写面流程测试 —— 与 pi 侧 extension-flow.test.ts 对称。
 *
 * 钉住的是「钩子挂在执行面」这条根因（设计 docs/design/llm-recorder-dsh-parity.md）：
 *   · 请求行必须来自 `llm/stream` 的 GenerateOptions（messages/system/tools 全量），
 *     不是 `agent/request` 的 LlmCallConfig（provider/model 五项）。
 *   · 响应行必须来自被包的 chunk 流（组装态 message），不是回合边界的一条空结算行。
 *   · 记录不得改变流：逐块按序原样交出、异常照样抛给下游、下游 break 也要结算。
 *
 * 放插件根目录而非 dsh-extension/ 内：该目录整体同步到内核插件目录，测试文件不能混进去。
 */

/** 假 ctx 的 handler 存宽签名：waterfall 钩子第二参是 next()，serial 事件钩子第二参是事件体
 *  （内核的派发方式不同，替身必须两副面孔都容得下——见 skill §11.12「替身比现实多给参数」）。 */
type Handler = (payload: unknown, ...rest: unknown[]) => unknown;

interface FakeDsh {
  on: (hook: string, handler: Handler, opts?: unknown) => void;
  /** llm/stream 是 waterfall：触发即得「被包的流」——返回值就是下游会消费的那一条。 */
  fireStream: (options: unknown, chunks: unknown[] | (() => unknown[])) => Promise<unknown[]>;
  /** 与 fireStream 同路，但把「被包的流」原样交出（测 break / 抛错这类消费侧行为）。 */
  streamOf: (options: unknown, chunks: () => unknown) => AsyncIterable<unknown>;
  fireSessionEvent: (session: { id: string }, event: unknown) => void;
  /** 原始 handler（测 next() 抛、测「不改写 options」用）。 */
  callStream: (options: unknown, next: () => unknown) => unknown;
}

function makeFakeDsh(): FakeDsh {
  const handlers = new Map<string, Handler>();
  const on = (hook: string, handler: Handler): void => {
    handlers.set(hook, handler);
  };
  const callStream = (options: unknown, next: () => unknown): unknown => {
    const h = handlers.get("llm/stream");
    if (!h) throw new Error("llm/stream 未注册 —— 写面挂在错误的钩子上");
    return h(options, next);
  };
  return {
    on,
    callStream,
    fireSessionEvent(session, event) {
      const h = handlers.get("session/event");
      if (h) h(session, event);
    },
    streamOf(options, chunks) {
      return callStream(options, chunks) as AsyncIterable<unknown>;
    },
    async fireStream(options, chunks) {
      const produce = typeof chunks === "function" ? (chunks as () => unknown) : () => chunks;
      const stream = callStream(options, () => produce()) as AsyncIterable<unknown>;
      const got: unknown[] = [];
      for await (const c of stream) got.push(c);
      return got;
    },
  };
}

const origCwd = process.cwd();
let tmp: string;
/** 每个用例一个独立会话 id：扩展的 `sessions` Map 是模块级状态，同一 id 会把上一个用例
 *  seq/分片缓存带过来。换 id 等价于「另一个会话/另一个 dsh 进程」，与真实场景一致。 */
let SID: string;
let sidSeq = 0;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llm-recorder-dsh-"));
  process.chdir(tmp);
  SID = `sid-${++sidSeq}`;
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const logFilePath = (): string => join(tmp, ".my-harness-desktop", "llm-logs", `${SID}.jsonl`);
const lines = (): ReturnType<typeof parseLogText> => parseLogText(readFileSync(logFilePath(), "utf8"));
const indexOf = (): { sessions: Record<string, { bytes: number; requests: number }> } =>
  JSON.parse(readFileSync(join(tmp, ".my-harness-desktop", "llm-logs", "index.json"), "utf8"));

/** 一轮完整的模型调用：GenerateOptions（执行面全量）+ 三段 chunk。 */
const FULL_OPTIONS = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: "us-new",
  model: "deepseek-v4-pro",
  messages: [
    { id: "m1", role: "user", content: [{ type: "text", text: "你好，介绍一下你自己" }], source: { kind: "user" } },
  ],
  system: "你是 Acme 的助手。",
  tools: [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
  temperature: 0.3,
  maxTokens: 8192,
  sessionId: SID,
  signal: { aborted: false, fake: "AbortSignal" },
  ...over,
});

const CHUNKS = [
  { type: "block-start", index: 0, blockType: "reasoning" },
  { type: "reasoning-delta", index: 0, text: "先想" },
  { type: "reasoning-delta", index: 0, text: "一下" },
  { type: "block-end", index: 0, block: { type: "reasoning", text: "先想一下" } },
  { type: "text-delta", index: 1, text: "你好！" },
  { type: "tool-call-delta", index: 2, id: "call_1", name: "bash", argumentsDelta: '{"command":' },
  { type: "tool-call-delta", index: 2, argumentsDelta: '"ls"}' },
  { type: "usage", usage: { inputTokens: 1200, outputTokens: 34, cacheReadTokens: 900 } },
  { type: "finish", reason: { kind: "tool-calls" } },
];

describe("llm-recorder dsh 写面：执行面数据", () => {
  it("请求行来自 llm/stream 的 GenerateOptions —— messages/system/tools 全量，而非 LlmCallConfig", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    dsh.fireSessionEvent({ id: SID }, { type: "step/start", turn: 3, step: 1 });
    await dsh.fireStream(FULL_OPTIONS(), CHUNKS);

    const req = lines().find((l) => l.kind === "request") as { payload?: Record<string, unknown>; turnIndex?: number } | undefined;
    expect(req, "必须落一条 request 行").toBeTruthy();
    expect(req!.turnIndex).toBe(3); // 回合身份来自 session/event 的 step/start
    const payload = req!.payload!;
    expect(payload.provider).toBe("us-new");
    expect(payload.model).toBe("deepseek-v4-pro");
    expect((payload.messages as unknown[]).length).toBe(1);
    expect(payload.system).toBe("你是 Acme 的助手。");
    expect((payload.tools as unknown[]).length).toBe(1);
    expect(payload.signal, "AbortSignal 是运行时句柄，不可序列化，必须丢掉").toBeUndefined();

    // 「一直只有 67B」的回归守卫：**行的大小必须随请求内容增长**（配置-only 的行不会）。
    // 不写魔法阈值——用不变量：行 ≥ messages+system+tools 的序列化字节。
    const contentBytes =
      JSON.stringify(payload.messages).length + JSON.stringify(payload.system).length + JSON.stringify(payload.tools).length;
    expect(readFileSync(logFilePath(), "utf8").split("\n")[0].length).toBeGreaterThanOrEqual(contentBytes);
  });

  it("请求行的体量随对话历史增长 —— 长上下文会话不会退化成一条配置行", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `第 ${i} 条消息，`.repeat(20) }], source: { kind: "user" },
    }));
    await dsh.fireStream(FULL_OPTIONS({ messages: big }), [{ type: "finish", reason: { kind: "stop" } }]);
    const first = readFileSync(logFilePath(), "utf8").split("\n")[0];
    const payload = (JSON.parse(first) as { payload: { messages: unknown[] } }).payload;
    expect(payload.messages).toHaveLength(200);
    // 200 条消息的真实体量：远超旧实现的 148B（正好是"核心内容全无"的对照）
    expect(Buffer.byteLength(first)).toBeGreaterThan(20_000);
  });

  it("回合外内部调用（purpose）不带 turnIndex —— 与 pi 的 compaction 同语义", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    dsh.fireSessionEvent({ id: SID }, { type: "step/start", turn: 3, step: 1 });
    await dsh.fireStream(FULL_OPTIONS({ purpose: "compaction" }), [{ type: "finish", reason: { kind: "stop" } }]);
    const req = lines().find((l) => l.kind === "request") as { turnIndex?: number; payload?: Record<string, unknown> } | undefined;
    expect(req!.turnIndex).toBeUndefined();
    expect(req!.payload!.purpose).toBe("compaction");
  });

  it("响应行是被包的 chunk 流组装出来的组装态消息（不是回合边界的一条空结算行）", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    await dsh.fireStream(FULL_OPTIONS(), CHUNKS);

    const res = lines().find((l) => l.kind === "response") as
      | { status?: number; message?: { content?: { type: string; text?: string; arguments?: string }[]; usage?: Record<string, number>; stopReason?: string } }
      | undefined;
    expect(res, "必须落一条 response 行").toBeTruthy();
    expect(res!.status, "dsh 不给 HTTP status：不伪造").toBeUndefined();
    const content = res!.message!.content!;
    expect(content.map((b) => b.type)).toEqual(["reasoning", "text", "tool-call"]);
    expect(content[0].text).toBe("先想一下");
    expect(content[1].text).toBe("你好！");
    expect(content[2].arguments, "tool-call-delta 攒出的 JSON 字符串").toBe('{"command":"ls"}');
    expect(res!.message!.usage).toMatchObject({ inputTokens: 1200, outputTokens: 34 });
    expect(res!.message!.stopReason).toBe("tool-calls");
    // 配对可用：读侧拿到的是「已返回且有内容」的一条记录
    const pair = pairRecords(lines())[0];
    expect(pair.response, "配对成功，面板不再停在「未返回」").toBeTruthy();
  });

  it("透传不干扰：chunk 逐块、按序、原样交给下游", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    const got = await dsh.fireStream(FULL_OPTIONS(), CHUNKS);
    expect(got).toEqual(CHUNKS);
  });

  it("下游抛错照样抛出，且失败事实落盘（error 行）", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    const boom = new Error("provider exploded");
    await expect(
      (async () => {
        const stream = dsh.streamOf(FULL_OPTIONS(), () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(boom),
          }),
        }));
        for await (const _ of stream) { /* 消费到抛 */ }
      })(),
    ).rejects.toThrow("provider exploded");
    const res = lines().find((l) => l.kind === "response") as { error?: { kind: string; message?: string } } | undefined;
    expect(res?.error?.kind).toBe("error");
    expect(res!.error!.message).toContain("provider exploded");
  });

  it("下游提前 break：已流出的片段照样结算（不留孤儿请求）", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    const stream = dsh.streamOf(FULL_OPTIONS(), () => ({
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return { next: () => Promise.resolve(i < CHUNKS.length ? { value: CHUNKS[i++], done: false } : { value: undefined, done: true }) };
      },
    }));
    let seen = 0;
    for await (const _ of stream) {
      seen += 1;
      if (seen === 2) break;
    }
    const res = lines().find((l) => l.kind === "response") as { message?: { content?: unknown[] } } | undefined;
    expect(res, "break 之后必须结算，否则面板永远显示「未返回」").toBeTruthy();
    expect(res!.message!.content!.length).toBe(1); // 只有 reasoning 那一块流出过
  });

  it("index.json 的 requests 只数 request 行 —— 与 pi 侧同口径（不再两倍）", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    await dsh.fireStream(FULL_OPTIONS(), CHUNKS);
    await dsh.fireStream(FULL_OPTIONS(), CHUNKS);
    // 键 = 首片文件名（<会话标识>.jsonl），与 pi 侧同约定——不是裸会话标识。
    // 这条断言是 e2e 对账抓出的第二处漂移的守卫（见 dsh-extension/index.mjs bumpIndex 注释）。
    expect(Object.keys(indexOf().sessions), "index 的键必须是首片文件名").toEqual([`${SID}.jsonl`]);
    expect(indexOf().sessions[`${SID}.jsonl`].requests).toBe(2);
    expect(lines().filter((l) => l.kind === "request")).toHaveLength(2);
    expect(lines().filter((l) => l.kind === "response")).toHaveLength(2);
  });

  it("开关关闭：纯透传，不落任何行", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(tmp, ".my-harness-desktop", "config"), { recursive: true });
    writeFileSync(join(tmp, ".my-harness-desktop", "config", "llm-recorder.json"), JSON.stringify({ recordEnabled: false }));
    const got = await dsh.fireStream(FULL_OPTIONS(), CHUNKS);
    expect(got).toEqual(CHUNKS);
    expect(() => readFileSync(logFilePath(), "utf8")).toThrow();
  });

  it("无 sessionId 的载荷不写（不产出无主孤儿文件）", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    await dsh.fireStream(FULL_OPTIONS({ sessionId: undefined }), CHUNKS);
    expect(() => readFileSync(logFilePath(), "utf8")).toThrow();
  });

  it("不改写内核交给我们的 options（只读）", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    const options = FULL_OPTIONS();
    const snapshot = JSON.stringify(options, (k, v) => (k === "signal" ? undefined : v));
    await dsh.fireStream(options, CHUNKS);
    expect(JSON.stringify(options, (k, v) => (k === "signal" ? undefined : v))).toBe(snapshot);
  });
});

describe("llm-recorder dsh 写面：seq 续号（真·进程重启 = 新模块实例）", () => {
  it("新进程接手同一会话：从磁盘最大 seq 续号，第一条就不撞号", async () => {
    // 第一代进程：真模块（模块级 sessions 状态从零开始）
    // @ts-expect-error 无类型声明的内核侧插件模块（见文件头）
    const m1 = (await import("./dsh-extension/index.mjs")) as { default: { apply: (c: unknown) => void } };
    const d1 = makeFakeDsh();
    m1.default.apply(d1 as never);
    await d1.fireStream(FULL_OPTIONS(), CHUNKS);
    await d1.fireStream(FULL_OPTIONS(), CHUNKS);
    expect(lines().filter((l) => l.kind === "request").map((l) => l.seq)).toEqual([1, 2]);

    // 第二代进程：vi.resetModules + 重新 import = 模块级 Map 真的从零开始（此前那个"重启"用例
    // 复用同一份模块状态，实际上没走到磁盘续号这条路——守卫是假的，这里补真）。
    vi.resetModules();
    // @ts-expect-error 无类型声明的内核侧插件模块（见文件头）
    const m2 = (await import("./dsh-extension/index.mjs")) as { default: { apply: (c: unknown) => void } };
    const d2 = makeFakeDsh();
    m2.default.apply(d2 as never);
    await d2.fireStream(FULL_OPTIONS(), CHUNKS);

    expect(lines().filter((l) => l.kind === "request").map((l) => l.seq), "重启后首条必须是 3，不是 1").toEqual([1, 2, 3]);
    const pairs = pairRecords(lines());
    expect(pairs.map((p) => p.seq)).toEqual([3, 2, 1]);
    expect(pairs.every((p) => p.response !== null), "三条请求都必须配上响应").toBe(true);
  });
});
