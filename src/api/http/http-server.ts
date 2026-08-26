// HTTP 服务(web-service-architecture.md §6.2/§7.3)——静态 + 状态。登录/鉴权是阶段 3,此处不涉及。
// 基础设施层:import node:http/fs/path(§7.3),不 import electron。依赖只向内。

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Gateway } from "../../core/application/remote/gateway";

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
export function createHttpServer(opts: { staticDir?: string; gateway?: Gateway }): Server {
  const { staticDir, gateway } = opts;

  return createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];

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
