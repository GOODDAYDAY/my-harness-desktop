// provider-probe 单元测试 + loopback 集成测试。
// 单元层用注入的 fetch mock 覆盖分支（解析/错误/降级/超时/key 解析/路径候选）；
// 集成层起真实 node http server 验证「发现 + ping 计时」端到端（不经 mock fetch）。
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { discoverModels, pingModel } from "./provider-probe";

/** 造一个 fetch mock：按 URL 分派响应，记录调用。 */
function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown } | never) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = handler(u, init);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

describe("discoverModels", () => {
  it("GET {baseUrl}/models，带 Bearer，id 排序返回；baseUrl 尾斜杠归一", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ body: { data: [{ id: "b-model" }, { id: "a-model" }, { no: "id" }] } }));
    const r = await discoverModels({ baseUrl: "https://x.test/v1/", apiKey: "sk-1", api: "openai-completions" }, { fetchImpl });
    expect(r).toEqual({ ok: true, models: ["a-model", "b-model"] });
    expect(calls[0].url).toBe("https://x.test/v1/models");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-1");
  });

  it("非 2xx → ok:false + HTTP 状态码与 body 截断", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 401, body: { error: "bad key" } }));
    const r = await discoverModels({ baseUrl: "https://x.test/v1", apiKey: "bad" }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 401");
    expect(r.error).toContain("bad key");
  });

  it("api 非探测支持集 → 显式降级，不发请求", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({}));
    const r = await discoverModels({ baseUrl: "https://x.test", api: "google-genai" }, { fetchImpl });
    expect(r).toEqual({ ok: false, error: "unsupported api: google-genai" });
    expect(calls).toHaveLength(0);
  });

  it("缺 baseUrl → 显式报错，不发请求", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({}));
    const r = await discoverModels({ baseUrl: "  " }, { fetchImpl });
    expect(r).toEqual({ ok: false, error: "missing baseUrl" });
    expect(calls).toHaveLength(0);
  });

  it("响应形状不符（无 data 数组）→ unexpected 错误", async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { models: [] } }));
    const r = await discoverModels({ baseUrl: "https://x.test" }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unexpected");
  });

  it("网络异常 → network: 带 cause 根因", async () => {
    const fetchImpl = (() => Promise.reject(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))) as unknown as typeof fetch;
    const r = await discoverModels({ baseUrl: "https://x.test" }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("network: ECONNREFUSED");
  });

  it("超时 → timeout Xs（AbortSignal.timeout 真实触发）", async () => {
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
      })) as unknown as typeof fetch;
    const r = await discoverModels({ baseUrl: "https://x.test" }, { fetchImpl, timeoutMs: 30 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("timeout 0s"); // 30ms 四舍五入到 0s——错误原文可读性优先
  });
});

describe("apiKey 解析（pi resolve-config-value 语义子集）", () => {
  it("`!cmd` 执行 shell 取 stdout 作为 Bearer", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ body: { data: [] } }));
    await discoverModels({ baseUrl: "https://x.test", apiKey: "!echo sk-from-cmd" }, { fetchImpl });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-from-cmd");
  });

  it("`$VAR` / `${VAR}` 环境变量插值", async () => {
    process.env.PROBE_TEST_KEY = "sk-env-1";
    const { calls, fetchImpl } = mockFetch(() => ({ body: { data: [] } }));
    await discoverModels({ baseUrl: "https://x.test", apiKey: "${PROBE_TEST_KEY}" }, { fetchImpl });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-env-1");
    delete process.env.PROBE_TEST_KEY;
  });

  it("命令失败 / env 缺失 → 显式报错，不发请求", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ body: { data: [] } }));
    const r1 = await discoverModels({ baseUrl: "https://x.test", apiKey: "!exit 1" }, { fetchImpl });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("apiKey resolution failed");
    const r2 = await discoverModels({ baseUrl: "https://x.test", apiKey: "$PROBE_MISSING_VAR" }, { fetchImpl });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("PROBE_MISSING_VAR");
    expect(calls).toHaveLength(0);
  });
});

describe("路径候选（baseUrl 带不带 /v1 两种约定）", () => {
  it("openai：原样优先，404 后回落 /v1", async () => {
    const { calls, fetchImpl } = mockFetch((url) =>
      url.endsWith("/v1/models") ? { body: { data: [{ id: "m1" }] } } : { status: 404, body: "nf" });
    const r = await discoverModels({ baseUrl: "https://x.test" }, { fetchImpl });
    expect(r).toEqual({ ok: true, models: ["m1"] });
    expect(calls.map((c) => c.url)).toEqual(["https://x.test/models", "https://x.test/v1/models"]);
  });

  it("anthropic：/v1 优先（官方约定 baseUrl 不含 /v1），直连成功不回落", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ body: { data: [{ id: "claude-x" }] } }));
    const r = await discoverModels({ baseUrl: "https://api.anthropic.test", apiKey: "k", api: "anthropic-messages" }, { fetchImpl });
    expect(r).toEqual({ ok: true, models: ["claude-x"] });
    expect(calls.map((c) => c.url)).toEqual(["https://api.anthropic.test/v1/models"]);
    expect((calls[0].init?.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect((calls[0].init?.headers as Record<string, string>)["anthropic-version"]).toBeTruthy();
  });

  it("候选全败 → 带回第一个错误（不吞不伪造）", async () => {
    const { fetchImpl } = mockFetch((url) => (url.includes("/v1/") ? { status: 503, body: "name resolution failed" } : { status: 400, body: "model_not_found" }));
    const r = await discoverModels({ baseUrl: "https://x.test" }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 400");
  });
});

describe("pingModel", () => {
  it("POST chat/completions：body 最小 ping（model/messages/max_tokens=1），2xx 记 latencyMs", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ body: { choices: [{ message: { content: "pong" } }] } }));
    const r = await pingModel({ baseUrl: "https://x.test/v1", apiKey: "sk-1", model: "m-1" }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(typeof r.latencyMs).toBe("number");
    expect(calls[0].url).toBe("https://x.test/v1/chat/completions");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ model: "m-1", max_tokens: 1, stream: false });
    expect(body.messages[0].content).toBe("ping");
  });

  it("anthropic：POST /v1/messages，x-api-key + anthropic-version 头", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ body: { id: "msg_1", type: "message", role: "assistant" } }));
    const r = await pingModel({ baseUrl: "https://gw.test", apiKey: "k2", api: "anthropic-messages", model: "claude-x" }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("https://gw.test/v1/messages");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k2");
    expect(headers["anthropic-version"]).toBeTruthy();
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ model: "claude-x", max_tokens: 1 });
  });

  it("ping 路径回落：无 /v1 405 → /v1 200（实测自建网关形态）", async () => {
    const { calls, fetchImpl } = mockFetch((url) =>
      url.endsWith("/v1/messages") ? { body: { id: "m" } } : { status: 405, body: "Method Not Allowed" });
    const r = await pingModel({ baseUrl: "https://gw.test", api: "anthropic-messages", model: "m" }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://gw.test/v1/messages"]); // /v1 优先，一次命中不回落
  });

  it("非 2xx → ok:false + latencyMs 仍带回（失败也耗时）", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, body: "model not found" }));
    const r = await pingModel({ baseUrl: "https://x.test", model: "ghost" }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 404");
    expect(r.latencyMs).toBeTypeOf("number");
  });

  it("api 缺省按 OpenAI 兼容处理；google-genai 显式降级", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ body: {} }));
    await pingModel({ baseUrl: "https://x.test", model: "m" }, { fetchImpl });
    expect(calls).toHaveLength(1);
    const r = await pingModel({ baseUrl: "https://x.test", api: "google-genai", model: "m" }, { fetchImpl });
    expect(r).toMatchObject({ ok: false, error: "unsupported api: google-genai" });
    expect(calls).toHaveLength(1); // 降级不发新请求
  });
});

describe("loopback 集成（真实 http server，不 mock fetch）", () => {
  async function withServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void, fn: (base: string) => Promise<void>): Promise<void> {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await fn(`http://127.0.0.1:${port}/v1`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("discover + ping 全链路：/models 出清单，ping 记到真实往返耗时（含服务端人工延迟）", async () => {
    await withServer((req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "slow-model" }, { id: "fast-model" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
        }, 80);
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    }, async (base) => {
      const d = await discoverModels({ baseUrl: base, apiKey: "k" });
      expect(d).toEqual({ ok: true, models: ["fast-model", "slow-model"] });
      const p = await pingModel({ baseUrl: base, model: "slow-model" });
      expect(p.ok).toBe(true);
      expect(p.latencyMs).toBeGreaterThanOrEqual(70); // 人工延迟 80ms，留 10ms 抖动余量
    });
  });

  it("ping 404 路径：ok:false 且错误带 HTTP 状态码", async () => {
    await withServer((_req, res) => { res.statusCode = 404; res.end("nope"); }, async (base) => {
      const p = await pingModel({ baseUrl: base, model: "x" });
      expect(p.ok).toBe(false);
      expect(p.error).toContain("HTTP 404");
    });
  });
});
