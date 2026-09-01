// provider-probe —— 对 OpenAI 兼容端点的纯 HTTP 探测（外层网络件，与 fs/git/npm 同层）。
//
// 两个能力（domain ModelProbeApi 的实现）：
//   discoverModels：GET {baseUrl}/models（Bearer apiKey）→ 模型 id 清单；
//   pingModel：POST {baseUrl}/chat/completions 发一条 max_tokens:1 的 "ping"，记请求往返耗时。
// 内核无关：不起内核进程、不读内核配置，连接事实（baseUrl/apiKey/api）全部由调用方显式传入。
//
// 显式降级：api 非 OpenAI 兼容（anthropic-messages / google-genai 等）时 ok:false +
// "unsupported api: <api>"，不静默、不伪造成功；缺 baseUrl 同理显式报错。
// fetch 可注入（测试 mock / loopback server），缺省 globalThis.fetch。
import type { ModelDiscoverResult, ModelProbeInput, ModelProbeResult } from "@my-harness-desktop/shared";

/** 支持探测的 api 类型（OpenAI 兼容端点都有 GET /models + POST /chat/completions）。 */
const PROBEABLE_APIS = new Set(["openai-completions", "openai-responses"]);

type FetchImpl = typeof fetch;

interface ProbeOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

const DISCOVER_TIMEOUT_MS = 15000;
const PING_TIMEOUT_MS = 60000;

/** 归一化 baseUrl：去尾部斜杠，缺协议不补（报错交给 fetch，原文带回）。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** api 类型门：不支持即显式降级（不发起任何请求）。 */
function unsupportedApiError(api?: string): string | null {
  if (!api) return null; // 缺省按 openai-completions 处理
  return PROBEABLE_APIS.has(api) ? null : `unsupported api: ${api}`;
}

/** fetch 异常 → 可读错误原文（超时单独命名，网络错误带 message）。 */
function fetchErrorMessage(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return `timeout ${Math.round(timeoutMs / 1000)}s`;
    // undici 的网络失败统一是 TypeError("fetch failed")，根因在 cause 里。
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `network: ${cause.message}`;
    return `network: ${err.message}`;
  }
  return String(err);
}

/** 非 2xx → "HTTP <status>: <body 截断 200 字符>"。 */
async function httpErrorMessage(res: Response): Promise<string> {
  let snippet = "";
  try {
    snippet = (await res.text()).slice(0, 200).trim();
  } catch { /* body 读失败不影响状态码结论 */ }
  return snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`;
}

/** GET {baseUrl}/models → 模型 id 清单（OpenAI 形状 {data:[{id}]}，按 id 排序）。 */
export async function discoverModels(input: ModelProbeInput, opts?: ProbeOptions): Promise<ModelDiscoverResult> {
  const gate = unsupportedApiError(input.api);
  if (gate) return { ok: false, error: gate };
  const base = normalizeBaseUrl(input.baseUrl ?? "");
  if (!base) return { ok: false, error: "missing baseUrl" };
  const timeoutMs = opts?.timeoutMs ?? DISCOVER_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(`${base}/models`, {
      method: "GET",
      headers: authHeaders(input.apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: await httpErrorMessage(res) };
    const body: unknown = await res.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return { ok: false, error: "unexpected /models response" };
    const models = data
      .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: fetchErrorMessage(err, timeoutMs) };
  }
}

/** POST {baseUrl}/chat/completions 发最小 ping，2xx 即通；latencyMs = 请求往返。 */
export async function pingModel(input: ModelProbeInput & { model: string }, opts?: ProbeOptions): Promise<ModelProbeResult> {
  const gate = unsupportedApiError(input.api);
  if (gate) return { ok: false, error: gate };
  const base = normalizeBaseUrl(input.baseUrl ?? "");
  if (!base) return { ok: false, error: "missing baseUrl" };
  const timeoutMs = opts?.timeoutMs ?? PING_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const t0 = Date.now();
  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(input.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) return { ok: false, latencyMs, error: await httpErrorMessage(res) };
    return { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: fetchErrorMessage(err, timeoutMs) };
  }
}
