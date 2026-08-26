// cloudflared 隧道(web-service §39)——spawn 子进程 + 逐行解析 trycloudflare URL + 生命周期。
// 依赖只向内:node:child_process。下载/二进制解析(§39.1)另行处理,此处只管起/停/解析 URL。

import { spawn, type ChildProcess } from "node:child_process";

export interface TunnelHandle {
  /** 解析出的公网 URL(未解析到 = null)。 */
  url: string | null;
  /** 关闭隧道(SIGTERM 子进程,URL 随即失效,§39.3)。 */
  stop(): void;
}

/**
 * 起一个 cloudflared 隧道(§39.2):spawn "tunnel --url http://127.0.0.1:<port>",
 * 逐行读 stdout 匹配 trycloudflare URL。onUrl 首解析到即回调;onExit 子进程退出回调。
 */
export function startTunnel(
  binary: string,
  port: number,
  onUrl: (url: string) => void,
  onExit: (code: number | null) => void,
): TunnelHandle {
  const proc: ChildProcess = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${port}`]);
  let url: string | null = null;

  proc.stdout?.on("data", (chunk: Buffer) => {
    if (url) return;
    const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      url = m[0];
      onUrl(url);
    }
  });
  proc.on("exit", (code) => onExit(code));

  return {
    get url() {
      return url;
    },
    stop() {
      proc.kill("SIGTERM");
    },
  };
}
