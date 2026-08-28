// 远程鉴权服务(web-service §8)——打包本地 token + serverSecret + 限速器 + 密码校验 + token 签发。
// 依赖只向内:node:crypto + 本目录的 token/rate-limiter/password/remote-config。

import { randomBytes, randomUUID } from "node:crypto";
import { RemoteConfigStore } from "./remote-config";
import { verifyPassword } from "./password";
import { signToken, verifyToken } from "./token";
import { createRateLimiter, type RateLimiter } from "./rate-limiter";
import type { TokenVerifier } from "../routing/gateway";

/** 远程鉴权服务。serverSecret 每次后端启动随机 → HMAC token 绑定进程,重启全失效(§37.2)。 */
export class RemoteAuth {
  readonly localToken: string;
  readonly serverSecret: string;
  readonly rateLimiter: RateLimiter;
  readonly config: RemoteConfigStore;

  constructor(config: RemoteConfigStore) {
    this.config = config;
    this.localToken = randomUUID();
    this.serverSecret = randomBytes(32).toString("hex");
    this.rateLimiter = createRateLimiter();
  }

  /** 复合 verifyToken(§8.2/§8.3):本地 token → local;HMAC token → 其 kind。 */
  createTokenVerifier(): TokenVerifier {
    return (token) => {
      if (token === this.localToken) return "local";
      const payload = verifyToken(token, this.serverSecret);
      return payload?.kind ?? null;
    };
  }

  /** 校验局域网密码(§8.1)。lan.enabled 关或无 hash → 一律拒绝(不静默放行)。 */
  checkPassword(password: string): boolean {
    const cfg = this.config.get();
    return cfg.lan.enabled && !!cfg.lan.passwordHash && verifyPassword(password, cfg.lan.passwordHash);
  }

  /** 签发远程 HMAC token(§37.2)。默认 24h 过期。 */
  signRemoteToken(ttlSec = 24 * 60 * 60): string {
    return signToken(
      { kind: "remote", exp: Math.floor(Date.now() / 1000) + ttlSec, nonce: randomUUID() },
      this.serverSecret,
    );
  }
}
