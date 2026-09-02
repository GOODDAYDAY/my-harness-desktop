// provider-probe —— 对 OpenAI / Anthropic 兼容端点的纯 HTTP 探测（外层网络件，与 fs/git/npm 同层）。
//
// 两个能力（domain ModelProbeApi 的实现）：
//   discoverModels：策略链逐个试（DISCOVER_STRATEGIES，一条策略 = 一种发现办法，
//     自含路径候选 + 鉴权头 + 响应解析；api 类型只影响排序，不过滤——「所有办法都试一遍」，
//     第一个 2xx 且解析成功的策略胜出，结果带 via 诊断）；加新办法 = 加一条策略对象。
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
// 饱和覆盖：不按声明的 api 类型设闸门——发现/ping 都把所有协议形状全量试一遍
// （api 只影响尝试顺序，不过滤），第一个 2xx 胜出；全灭带回第一个错误（诚实，不伪造）。
// fetch 可注入（测试 mock / loopback server），缺省 globalThis.fetch。
import { execSync } from "node:child_process";
import type { ModelDiscoverResult, ModelProbeInput, ModelProbeResult } from "@my-harness-desktop/shared";

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
/** 发现策略：一种「列出端点模型」的办法，自含 路径候选 + 鉴权头 + 响应解析。
 *  高内聚低耦合：加新办法 = 往 DISCOVER_STRATEGIES 加一条对象，discoverModels 不动。 */
interface DiscoverStrategy {
  /** 策略名（进结果的 via 字段，诊断用）。 */
  id: string;
  /** 有序路径候选（相对 baseUrl；带不带 /v1 的两种约定都在这里枚举）。 */
  paths: string[];
  /** 鉴权头（key 已解析；空 key 返回空——无鉴权端点也允许试）。 */
  headers(key?: string): Record<string, string>;
  /** 2xx 响应体 → 模型 id 清单；形状不识返回 null（视为未命中，继续下一条）。 */
  parse(body: unknown): string[] | null;
}

/** OpenAI 形状解析：{data:[{id}]}（Anthropic /v1/models 同形）。 */
function parseDataIds(body: unknown): string[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** 发现策略注册表（顺序 = 缺省优先级；调用时按 api 亲和再排）。
 *  当前两条：OpenAI 兼容的 /models（Bearer）、Anthropic 的 /v1/models（x-api-key）。 */
const DISCOVER_STRATEGIES: DiscoverStrategy[] = [
  { id: "openai-models", paths: ["/models", "/v1/models"], headers: (key): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {}), parse: parseDataIds },
  { id: "anthropic-models", paths: ["/v1/models", "/models"], headers: (key): Record<string, string> => (key ? { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } : {}), parse: parseDataIds },
];

/** api 亲和排序：声明 anthropic 的端点先试 anthropic 策略，其余先试 openai；只是排序不过滤。 */
function orderStrategies(api?: string): DiscoverStrategy[] {
  if (api !== "anthropic-messages") return DISCOVER_STRATEGIES;
  return [...DISCOVER_STRATEGIES].sort((a, b) => (a.id === "anthropic-models" ? -1 : b.id === "anthropic-models" ? 1 : 0));
}

/** GET 模型清单：策略链逐个试，第一个 2xx 且解析成功的胜出（via 记录命中策略）；
 *  全链未命中带回第一个错误（诚实，不伪造）。 */
export async function discoverModels(input: ModelProbeInput, opts?: ProbeOptions): Promise<ModelDiscoverResult> {
  const base = normalizeBaseUrl(input.baseUrl ?? "");
  if (!base) return { ok: false, error: "missing baseUrl" };
  const { key, error: keyError } = resolveApiKey(input.apiKey);
  if (keyError) return { ok: false, error: keyError };
  const timeoutMs = opts?.timeoutMs ?? DISCOVER_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  let firstError: string | null = null;
  for (const strategy of orderStrategies(input.api)) {
    for (const path of strategy.paths) {
      try {
        const res = await fetchImpl(`${base}${path}`, { method: "GET", headers: strategy.headers(key), signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) { firstError ??= await httpErrorMessage(res); continue; }
        const models = strategy.parse(await res.json().catch(() => null));
        if (models) return { ok: true, models: models.sort(), via: strategy.id };
        firstError ??= "unexpected /models response";
      } catch (err) {
        firstError ??= fetchErrorMessage(err, timeoutMs);
      }
    }
  }
  return { ok: false, error: firstError ?? "no endpoint" };
}

/** Ping 策略：一种「最小请求测往返」的协议形状，自含 路径候选 + 鉴权头 + 请求体。
 *  与发现策略同范式——加新协议形状 = 往 PING_STRATEGIES 加一条对象。 */
interface PingStrategy {
  id: string;
  /** 有序路径候选（带不带 /v1 的两种约定都在这里枚举）。 */
  paths: string[];
  headers(key?: string): Record<string, string>;
  body(model: string): unknown;
}

/** ping 策略注册表（顺序 = 缺省优先级；调用时按 api 亲和再排）。 */
const PING_STRATEGIES: PingStrategy[] = [
  {
    id: "openai-chat",
    paths: ["/chat/completions", "/v1/chat/completions"],
    headers: (key): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {}),
    body: (model) => ({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
  },
  {
    id: "anthropic-messages",
    paths: ["/v1/messages", "/messages"],
    headers: (key): Record<string, string> => (key ? { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } : {}),
    body: (model) => ({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
  },
];

/** api 亲和排序：声明 anthropic 的先试 anthropic 形状，其余先试 openai；只是排序不过滤（饱和覆盖）。 */
function orderPingStrategies(api?: string): PingStrategy[] {
  if (api !== "anthropic-messages") return PING_STRATEGIES;
  return [...PING_STRATEGIES].sort((a, b) => (a.id === "anthropic-messages" ? -1 : b.id === "anthropic-messages" ? 1 : 0));
}

/** POST 最小 ping（max_tokens:1）：饱和覆盖——所有协议形状全量试，第一个 2xx 胜出，
 *  via 记录命中形状；全灭带回第一个错误。 */
export async function pingModel(input: ModelProbeInput & { model: string }, opts?: ProbeOptions): Promise<ModelProbeResult> {
  const base = normalizeBaseUrl(input.baseUrl ?? "");
  if (!base) return { ok: false, error: "missing baseUrl" };
  const { key, error: keyError } = resolveApiKey(input.apiKey);
  if (keyError) return { ok: false, error: keyError };
  const timeoutMs = opts?.timeoutMs ?? PING_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  let firstError: { latencyMs: number; error: string } | null = null;
  for (const strategy of orderPingStrategies(input.api)) {
    for (const path of strategy.paths) {
      const t0 = Date.now();
      try {
        const res = await fetchImpl(`${base}${path}`, {
          method: "POST",
          headers: { ...strategy.headers(key), "Content-Type": "application/json" },
          body: JSON.stringify(strategy.body(input.model)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const latencyMs = Date.now() - t0;
        if (res.ok) return { ok: true, latencyMs, via: strategy.id };
        firstError ??= { latencyMs, error: await httpErrorMessage(res) };
      } catch (err) {
        const latencyMs = Date.now() - t0;
        firstError ??= { latencyMs, error: fetchErrorMessage(err, timeoutMs) };
      }
    }
  }
  const f = firstError ?? { latencyMs: 0, error: "no endpoint" };
  return { ok: false, latencyMs: f.latencyMs, error: f.error };
}
