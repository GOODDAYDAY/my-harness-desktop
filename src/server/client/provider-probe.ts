// provider-probe —— 对 OpenAI / Anthropic 兼容端点的纯 HTTP 探测（外层网络件，与 fs/git/npm 同层）。
//
// 两个能力（domain ModelProbeApi 的实现）：
//   discoverModels：GET 模型清单（OpenAI: /models；Anthropic: /v1/models，两边响应都是 {data:[{id}]}）；
//   pingModel：POST 一条最小请求记往返（OpenAI: /chat/completions；Anthropic: /v1/messages，max_tokens:1）。
// 内核无关：不起内核进程、不读内核配置，连接事实（baseUrl/apiKey/api）全部由调用方显式传入。
//
// 三个真实世界适配（全是实测驱动的）：
// 1. apiKey 解析对齐 pi 的 resolve-config-value 语义：`!cmd` 执行 shell 取 stdout、
//    `$VAR`/`${VAR}` 环境变量插值（`$$`/`$!` 转义）——models.json 里的 key 经常是命令引用，
//    不把字面 `!cmd` 当 Bearer 发出去（实测：不解析即 401）。
// 2. 路径候选：baseUrl 带不带 /v1 两种约定都存在（官方 Anthropic baseUrl 不含 /v1；
//    pi 的 OpenAI 约定含）。按 api 类型排好优先级逐个试，第一个 2xx 胜出；
//    全败带回第一个错误（诚实，不伪造）。
// 3. 很多自建网关根本没有列表端点（GET /models 400/404/503）——discover 如实报错，
//    UI 层负责「改用已配置模型」的降级路径。
//
// 显式降级：api 非探测支持集（google-genai 等）→ ok:false + "unsupported api: <api>"，不发请求。
// fetch 可注入（测试 mock / loopback server），缺省 globalThis.fetch。
import { execSync } from "node:child_process";
import type { ModelDiscoverResult, ModelProbeInput, ModelProbeResult } from "@my-harness-desktop/shared";

/** 支持探测的 api 类型（OpenAI 兼容 + Anthropic messages）。 */
const PROBEABLE_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

type FetchImpl = typeof fetch;

interface ProbeOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

const DISCOVER_TIMEOUT_MS = 15000;
const PING_TIMEOUT_MS = 60000;
const ANTHROPIC_VERSION = "2023-06-01";

/** 归一化 baseUrl：去尾部斜杠，缺协议不补（报错交给 fetch，原文带回）。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

const ENV_VAR_RE = /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** apiKey 解析（对齐 pi resolve-config-value 语义的最小子集）：
 *  `!cmd` → 执行 shell 取 stdout（10s 超时）；`$VAR`/`${VAR}` → process.env 插值；
 *  其余按字面值。解析失败返回 error，不静默降级为「不带 key」。 */
function resolveApiKey(raw?: string): { key?: string; error?: string } {
  if (!raw) return {};
  if (raw.startsWith("!")) {
    try {
      const out = execSync(raw.slice(1), { encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      return out ? { key: out } : { error: "apiKey resolution failed (empty command output)" };
    } catch {
      return { error: "apiKey resolution failed (command)" };
    }
  }
  let missing: string | null = null;
  const key = raw.replace(ENV_VAR_RE, (whole, braceName, bareName) => {
    if (whole === "$$") return "$";
    if (whole === "$!") return "!";
    const name = braceName ?? bareName;
    const v = process.env[name];
    if (v === undefined) { missing = name; return whole; }
    return v;
  });
  return missing ? { error: `apiKey resolution failed (env $${missing} not set)` } : { key };
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

/** 路径候选：baseUrl 带不带 /v1 的两种约定都试，按 api 类型排优先级（去重）。
 *  OpenAI 系先按 baseUrl 原样（pi 约定含 /v1）；Anthropic 系先插 /v1（官方约定不含）。 */
function candidateUrls(base: string, path: string, api?: string): string[] {
  const direct = `${base}${path}`;
  const withV1 = `${base}/v1${path}`;
  const urls = api === "anthropic-messages" ? [withV1, direct] : [direct, withV1];
  return [...new Set(urls)];
}

/** 按候选顺序逐个试，第一个 2xx 胜出（带回该次耗时）；全败带回第一个错误。 */
async function tryCandidates(
  urls: string[],
  init: () => RequestInit,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<{ ok: true; latencyMs: number; res: Response } | { ok: false; latencyMs: number; error: string }> {
  let firstError: { latencyMs: number; error: string } | null = null;
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const res = await fetchImpl(url, { ...init(), signal: AbortSignal.timeout(timeoutMs) });
      const latencyMs = Date.now() - t0;
      if (res.ok) return { ok: true, latencyMs, res };
      const error = await httpErrorMessage(res);
      firstError ??= { latencyMs, error };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      firstError ??= { latencyMs, error: fetchErrorMessage(err, timeoutMs) };
    }
  }
  const f = firstError ?? { latencyMs: 0, error: "no endpoint" };
  return { ok: false, latencyMs: f.latencyMs, error: f.error };
}

function authHeaders(apiKey: string | undefined, api?: string): Record<string, string> {
  if (!apiKey) return {};
  return api === "anthropic-messages"
    ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }
    : { Authorization: `Bearer ${apiKey}` };
}

/** GET 模型清单 → id 数组（OpenAI 与 Anthropic 响应同为 {data:[{id}]}，按 id 排序）。 */
export async function discoverModels(input: ModelProbeInput, opts?: ProbeOptions): Promise<ModelDiscoverResult> {
  const gate = unsupportedApiError(input.api);
  if (gate) return { ok: false, error: gate };
  const base = normalizeBaseUrl(input.baseUrl ?? "");
  if (!base) return { ok: false, error: "missing baseUrl" };
  const { key, error: keyError } = resolveApiKey(input.apiKey);
  if (keyError) return { ok: false, error: keyError };
  const timeoutMs = opts?.timeoutMs ?? DISCOVER_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const headers = authHeaders(key, input.api);
  const r = await tryCandidates(candidateUrls(base, "/models", input.api), () => ({ method: "GET", headers }), fetchImpl, timeoutMs);
  if (!r.ok) return { ok: false, error: r.error };
  const body: unknown = await r.res.json().catch(() => null);
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { ok: false, error: "unexpected /models response" };
  const models = data
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
  return { ok: true, models };
}

/** POST 最小 ping（OpenAI chat/completions / Anthropic messages，max_tokens:1），2xx 即通。 */
export async function pingModel(input: ModelProbeInput & { model: string }, opts?: ProbeOptions): Promise<ModelProbeResult> {
  const gate = unsupportedApiError(input.api);
  if (gate) return { ok: false, error: gate };
  const base = normalizeBaseUrl(input.baseUrl ?? "");
  if (!base) return { ok: false, error: "missing baseUrl" };
  const { key, error: keyError } = resolveApiKey(input.apiKey);
  if (keyError) return { ok: false, error: keyError };
  const timeoutMs = opts?.timeoutMs ?? PING_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const anthropic = input.api === "anthropic-messages";
  const path = anthropic ? "/messages" : "/chat/completions";
  const body = anthropic
    ? { model: input.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
    : { model: input.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
  const headers = { ...authHeaders(key, input.api), "Content-Type": "application/json" };
  const r = await tryCandidates(candidateUrls(base, path, input.api), () => ({ method: "POST", headers, body: JSON.stringify(body) }), fetchImpl, timeoutMs);
  if (!r.ok) return { ok: false, latencyMs: r.latencyMs, error: r.error };
  return { ok: true, latencyMs: r.latencyMs };
}
