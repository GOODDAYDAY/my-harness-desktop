// minimal 模型客户端 —— OpenAI 兼容 /chat/completions 的 SSE 流式调用(独立模块,零壳依赖)。
//
// 依据 docs/design/minimal-kernel.md §4.7/§4.8/§4.9。这是「内核本体」的模型层:读 minimal
// 自己的模型配置(providers + default),发流式请求(stream:true),逐 delta 回调。未配置时
// 由调用方回落 echo——真模型是可选能力,不配置也能跑(独立内核的「可用」底线)。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * minimal 模型配置(§4.9.1):providers + default。apiKey 与配置分离——配置文件里不留明文
 * 密钥,apiKey 落独立的凭证文件(§4.9.2),这里只读引用。
 */
export function loadModelConfig(agentDir) {
  const p = join(agentDir, "models.json");
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, "utf-8"));
    return {
      providers: Array.isArray(cfg.providers) ? cfg.providers : [],
      default: cfg.default ?? null,
    };
  } catch {
    return null;
  }
}

/** 从凭证文件读 apiKey(独立于配置,§4.9.2)。 */
function loadApiKey(agentDir, providerId) {
  const p = join(agentDir, ".credentials.json");
  if (!existsSync(p)) return undefined;
  try {
    const c = JSON.parse(readFileSync(p, "utf-8"));
    return c[providerId] ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 模型调用的**空闲超时**默认值（§4.7.1/§4.6.1：客户端必须处理"超时、重连、中断"三件事，
 * 其中"重连"第一版可显式降级，但**超时和中断是必须的**）。
 *
 * 为什么它是必须的（文档原话）："没有它们，一个卡住的模型调用会永远占住 minimal 的进程"。
 * 此前只做了中断（signal）没做超时：服务端接了连接却不发数据、或流发到一半不再动，
 * `reader.read()` 就永远挂着 → 这一回合永不收敛（`agentSettled` 永不发）→
 * 壳侧"运行中"永远转。用户只能手动 abort 才解得开。
 *
 * 取 120 秒：这是**空闲**超时（两次数据之间），不是总时长——推理模型的首 token 可能很慢，
 * 但只要还在吐数据就不该掐。真正要防的是"彻底不动了"。
 */
export const MODEL_IDLE_TIMEOUT_MS = (() => {
  // 可用环境变量覆盖（`MHD_MINIMAL_MODEL_IDLE_MS`）：给测试一个**不打生产折扣**的接缝
  // （测试里不必真的等 120 秒），也让运维能在不改代码的前提下调它。
  const raw = Number(process.env.MHD_MINIMAL_MODEL_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

/**
 * 流式调 OpenAI 兼容端点(§4.7/§4.8):POST /chat/completions stream:true,逐 data 行解析
 * `choices[0].delta.content`,每次增量回调 onDelta。signal 供 abort 掐断(§4.6.2)。
 *
 * `hooks.idleTimeoutMs`：空闲超时（缺省 MODEL_IDLE_TIMEOUT_MS）。到点**自己** abort，
 * 抛一个说得清的错（"模型调用超时(空闲 Ns)"）——注意**不能**去 abort 调用方的 controller：
 * 那会让 CLI 把它当成"用户主动停止（stopped）"，而它其实是失败（error）。两者语义不同
 * （§4.6.2 把这条钉死过），所以这里用**自己的** AbortController，只挂在调用方 signal 上做联动。
 */
export async function streamModel(config, agentDir, providerId, modelId, messages, tools, hooks) {
  // 回调收成一个对象而不是继续加位置参数：这个函数已经 7 个位置参数了，
  // 再加一个"只在有工具调用时才用得上"的回调，调用点会变成一串看不出语义的实参。
  // hooks.onDelta(text) 增量文本；hooks.onToolCallDelta(tc, index) 工具参数分片（§4.8.2）；
  // hooks.signal AbortSignal（掐流）。
  const { onDelta, onToolCallDelta, signal } = hooks ?? {};
  const idleTimeoutMs = hooks?.idleTimeoutMs > 0 ? hooks.idleTimeoutMs : MODEL_IDLE_TIMEOUT_MS;
  const provider = config.providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`provider 不存在: ${providerId}`);
  const apiKey = loadApiKey(agentDir, providerId) ?? provider.apiKey;
  const url = `${String(provider.baseURL).replace(/\/$/, "")}/chat/completions`;
  // 自己的 AbortController：空闲超时只掐本次请求，不污染调用方的 abort 语义（见函数头注释）。
  const local = new AbortController();
  const onCallerAbort = () => local.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  let idleTimer = null;
  let idleTimedOut = false;
  /** 每收到一段数据就重置空闲计时；到点即掐。 */
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      local.abort();
    }, idleTimeoutMs);
  };
  bumpIdle();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    // `stream_options.include_usage`：OpenAI 兼容端点在**最后一帧**才带 usage；
    // 不显式要，多数网关就不发 → 用量永远拿不到（文档 §3.3.3 明确要求 message 里含 usage）。
    body: JSON.stringify({
      model: modelId, messages,
      ...(tools?.length ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: local.signal,
  }).catch((e) => {
    if (idleTimedOut) throw new Error(`模型调用超时(空闲 ${Math.round(idleTimeoutMs / 1000)}s): 连接后没有任何数据`);
    throw e;
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`模型请求失败 ${res.status}: ${body.slice(0, 200)}`);
  }
  bumpIdle(); // 响应头已到，开始按"两次数据之间"计空闲
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acc = "";
  /** 用量与停止原因（§3.3.3：message 里要含 usage / stopReason）。
   *  两者都在流里出现，此前**整个丢掉**——于是 minimal 会话没有用量基线，
   *  项目统计里 minimal 的会话恒为 0（pi/dsh 都有真数字），"同等功能"缺一块。 */
  let usage;
  let stopReason;
  // tool_call 分片聚合(§4.8.2):按 index 缓冲,arguments 追加拼接(非覆盖)。
  const toolBufs = new Map();
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      // 空闲超时掐断：给一个**说得清**的错（不是裸 AbortError）——它会被 CLI 记成
      // 失败（messageEnd.error + agentSettled.reason=error），不是 stopped。
      if (idleTimedOut) throw new Error(`模型调用超时(空闲 ${Math.round(idleTimeoutMs / 1000)}s): 流中途停止`);
      throw e;
    } finally {
      bumpIdle();
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        return { text: acc, toolCalls: [...toolBufs.values()].filter((t) => t.name), usage, stopReason };
      }
      try {
        const j = JSON.parse(data);
        // usage 归一成**中性用量形状**（圆心 messageUsageOf 是唯一解析处，这里按它的字段写）：
        // OpenAI 的 prompt_tokens 已含缓存命中，且 total = prompt + completion，与
        // pi 的 `input + output = totalTokens` 同口径（对照真实 pi 会话文件实证）。
        if (j.usage && typeof j.usage === "object") {
          const u = j.usage;
          const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          usage = {
            input: n(u.prompt_tokens),
            output: n(u.completion_tokens),
            cacheRead: n(u.prompt_tokens_details?.cached_tokens),
            cacheWrite: n(u.prompt_tokens_details?.cache_creation_tokens ?? u.cache_creation_input_tokens),
            totalTokens: n(u.total_tokens) || n(u.prompt_tokens) + n(u.completion_tokens),
          };
        }
        const fr = j.choices?.[0]?.finish_reason;
        if (typeof fr === "string" && fr) stopReason = fr;
        const delta = j.choices?.[0]?.delta;
        if (typeof delta?.content === "string") { acc += delta.content; onDelta(delta.content); }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            let buf = toolBufs.get(i);
            if (!buf) { buf = { id: "", name: "", arguments: "", index: i }; toolBufs.set(i, buf); }
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) {
              buf.arguments += tc.function.arguments;
              // 参数分片流式上报（§4.8.2：id 首次到位发 toolCallStart、之后 arguments 继续到达发
              // toolCallUpdate）。内核只上报**已知的部分**（buf 的当前快照），不替调用方攒批——
              // 攒批是消费方的事（壳按 toolCallId 覆盖式渲染）。
              onToolCallDelta?.({ id: buf.id, name: buf.name, arguments: buf.arguments, index: i });
            }
          }
        }
      } catch {
        // 损坏 data 行跳过。
      }
    }
  }
  // 流没给 [DONE] 就断了（网关提前关流）：已有内容照常返回，usage/stopReason 可能缺——
  // 缺就是缺，不编造（口径：拿不到的东西不写假值）。
  clearTimeout(idleTimer);
  signal?.removeEventListener("abort", onCallerAbort);
  return { text: acc, toolCalls: [...toolBufs.values()].filter((t) => t.name), usage, stopReason };
}
