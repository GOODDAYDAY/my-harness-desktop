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
 * 流式调 OpenAI 兼容端点(§4.7/§4.8):POST /chat/completions stream:true,逐 data 行解析
 * `choices[0].delta.content`,每次增量回调 onDelta。signal 供 abort 掐断(§4.6.2)。
 */
export async function streamModel(config, agentDir, providerId, modelId, messages, tools, onDelta, signal) {
  const provider = config.providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`provider 不存在: ${providerId}`);
  const apiKey = loadApiKey(agentDir, providerId) ?? provider.apiKey;
  const url = `${String(provider.baseURL).replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: modelId, messages, ...(tools?.length ? { tools } : {}), stream: true }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`模型请求失败 ${res.status}: ${body.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acc = "";
  // tool_call 分片聚合(§4.8.2):按 index 缓冲,arguments 追加拼接(非覆盖)。
  const toolBufs = new Map();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        return { text: acc, toolCalls: [...toolBufs.values()].filter((t) => t.name) };
      }
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta;
        if (typeof delta?.content === "string") { acc += delta.content; onDelta(delta.content); }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            let buf = toolBufs.get(i);
            if (!buf) { buf = { id: "", name: "", arguments: "" }; toolBufs.set(i, buf); }
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) buf.arguments += tc.function.arguments;
          }
        }
      } catch {
        // 损坏 data 行跳过。
      }
    }
  }
  return { text: acc, toolCalls: [...toolBufs.values()].filter((t) => t.name) };
}
