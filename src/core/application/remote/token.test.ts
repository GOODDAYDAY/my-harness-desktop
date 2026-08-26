// HMAC token + 失败限速器单测(web-service §8.4/§19.3/§37.2)。

import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "./token";
import { createRateLimiter } from "./rate-limiter";

describe("token(HMAC)", () => {
  const secret = "server-secret";
  const payload = { kind: "remote" as const, exp: Math.floor(Date.now() / 1000) + 60, nonce: "n1" };

  it("sign → verify 往返一致", () => {
    const t = signToken(payload, secret);
    expect(verifyToken(t, secret)).toEqual(payload);
  });

  it("签名被篡改 → null", () => {
    const t = signToken(payload, secret);
    expect(verifyToken(t + "x", secret)).toBeNull();
  });

  it("载荷被篡改(重签不了)→ null", () => {
    const t = signToken(payload, secret);
    const [body] = t.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...payload, kind: "local" })).toString("base64url")}.${t.split(".")[1]}`;
    expect(forged.split(".")[0]).not.toBe(body);
    expect(verifyToken(forged, secret)).toBeNull();
  });

  it("过期 → null", () => {
    const exp = Math.floor(Date.now() / 1000) - 1;
    const t = signToken({ ...payload, exp }, secret);
    expect(verifyToken(t, secret)).toBeNull();
  });

  it("换 secret → null(token 绑定进程,重启失效)", () => {
    const t = signToken(payload, secret);
    expect(verifyToken(t, "other-secret")).toBeNull();
  });
});

describe("rateLimiter(5 错锁 60s)", () => {
  it("连续 5 错 → 锁", () => {
    const r = createRateLimiter({ maxFailures: 5, lockSec: 60 });
    for (let i = 0; i < 4; i++) expect(r.recordFailure("ip1").locked).toBe(false);
    const fifth = r.recordFailure("ip1");
    expect(fifth.locked).toBe(true);
    expect(fifth.retryAfterSec).toBe(60);
  });

  it("锁定期内持续锁,成功清零", () => {
    const r = createRateLimiter({ maxFailures: 2, lockSec: 60 });
    r.recordFailure("ip1");
    expect(r.recordFailure("ip1").locked).toBe(true);
    expect(r.recordFailure("ip1").locked).toBe(true); // 锁内仍锁
    r.recordSuccess("ip1");
    expect(r.recordFailure("ip1").locked).toBe(false); // 清零后重新计数
  });

  it("不同 key 互不影响", () => {
    const r = createRateLimiter({ maxFailures: 2, lockSec: 60 });
    r.recordFailure("ip1"); // ip1 第 1 错(未锁)
    expect(r.recordFailure("ip1").locked).toBe(true); // ip1 第 2 错 → 锁
    expect(r.recordFailure("ip2").locked).toBe(false); // ip2 第 1 错,独立不锁
  });
});
