// HMAC 会话 token(web-service §37.2)——base64url(payload) + hmac 签名。
// serverSecret 每次后端启动随机 → token 绑定进程,重启全失效。依赖只向内:仅 node:crypto。
// 常量时间比较防时序侧信道。

import { createHmac, timingSafeEqual } from "node:crypto";

/** token 载荷(§37.2)。kind 是客户端身份(§8.3),exp 是过期 unix 秒,nonce 是随机串。 */
export interface TokenPayload {
  kind: "local" | "remote";
  exp: number;
  nonce: string;
}

/** 签名:JSON → base64url + hmac。 */
export function signToken(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** 校验:签名一致(常量时间)+ 载荷合法 + 未过期。失败返回 null。 */
export function verifyToken(token: string, secret: string): TokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as TokenPayload;
    if (typeof payload.kind !== "string" || typeof payload.exp !== "number" || typeof payload.nonce !== "string") return null;
    if (payload.exp < Date.now() / 1000) return null; // 过期
    return payload;
  } catch {
    return null;
  }
}
