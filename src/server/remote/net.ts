// 远程来源判定与 cookie 解析(web-service §8.2/§8.3)——http 与 ws 两个传输共用,单源。
// 依赖只向内:零 import。

/** 会话 cookie 名(§8.2):/login 种 httpOnly,静态/WS 请求随浏览器携带。 */
export const SESSION_COOKIE = "mhd_session";

/** loopback 来源判定(§8.3 本机信任边界):127.0.0.1 / ::1 / IPv4 映射 ::ffff:127.0.0.1。 */
export function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

/** 解析 Cookie 头 → { name: value }(§8.2)。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}
