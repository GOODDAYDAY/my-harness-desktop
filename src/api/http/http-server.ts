// HTTP 服务(web-service-architecture.md §6.2/§7.3)——静态 + 状态。登录/鉴权是阶段 3,此处不涉及。
// 基础设施层:import node:http/fs/path(§7.3),不 import electron。依赖只向内。

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Gateway } from "../../core/application/remote/gateway";
import type { RemoteAuth } from "../../core/application/remote/auth";

/** 常见静态资源的 content-type。 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** 组装 HTTP 服务器(§6.2):GET / 静态(SPA 回退 index.html)+ /status.json。 */
export function createHttpServer(opts: { staticDir?: string; gateway?: Gateway; auth?: RemoteAuth }): Server {
  const { staticDir, gateway, auth } = opts;

  return createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    // POST /login —— 密码校验 → HMAC token(§8.2)。限速 5 错锁 60s(§8.4)。
    if (url === "/login" && req.method === "POST") {
      if (!auth) { res.writeHead(503); res.end("remote auth not configured"); return; }
      const ip = req.socket.remoteAddress ?? "unknown";
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const lock = auth.rateLimiter.recordFailure(ip);
        if (lock.locked) {
          res.writeHead(429, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "尝试过多,请稍后再试", retryAfterSec: lock.retryAfterSec }));
          return;
        }
        let password = "";
        try { password = (JSON.parse(body) as { password?: string }).password ?? ""; } catch { /* bad body */ }
        if (password && auth.checkPassword(password)) {
          auth.rateLimiter.recordSuccess(ip);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, token: auth.signRemoteToken() }));
        } else {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "密码错误" }));
        }
      });
      return;
    }
    if (url === "/logout" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // /status.json —— 网关健康/状态(§6.2/§28.2)
    if (url === "/status.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        enabled: true,
        boundAddress: "",
        connections: gateway?.connectionCount() ?? 0,
        channels: gateway?.channelCount() ?? 0,
      }));
      return;
    }

    // 静态(SPA 回退 index.html)。阶段 1 的 staticDir 由 bootstrap 注入(§21)。
    if (!staticDir) {
      res.writeHead(404);
      res.end("no static dir");
      return;
    }
    const rel = normalize(url).replace(/^([/\\])+/, "");
    const file = join(staticDir, rel === "" ? "index.html" : rel);
    const target = existsSync(file) ? file : join(staticDir, "index.html"); // SPA 回退
    try {
      const buf = await readFile(target);
      res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
}
