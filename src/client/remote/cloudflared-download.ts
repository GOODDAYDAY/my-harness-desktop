// cloudflared 二进制确保(web-service §39.1)——PATH 已有 → 安装目录已装 → 下载(镜像顺序)。
// 依赖只向内:node:fs + node:child_process + node:path + global fetch(Node 18+)。

import { existsSync, mkdirSync, chmodSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** 平台 → cloudflared 资产名(§39.1,Windows 加 .exe)。 */
function assetName(): string {
  const plat = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const ext = process.platform === "win32" ? ".exe" : "";
  return `cloudflared-${plat}-${arch}${ext}`;
}

/** 下载源(§39.1:清华镜像 → 官方 GitHub → 加速源)。 */
function downloadUrls(asset: string): string[] {
  return [
    `https://mirrors.tuna.tsinghua.edu.cn/github-release/cloudflare/cloudflared/LatestRelease/${asset}`,
    `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  ];
}

/** PATH 里找已装的 cloudflared(Windows 分隔符是 ';')。 */
function findInPath(name: string): string | null {
  const path = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of path.split(sep)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 确保 cloudflared 可用,返回二进制绝对路径。顺序(§39.1):
 * 1. PATH 里已有 → 直接返回其路径;2. 安装目录已装 → 返回;3. 逐源下载 + chmod +x。
 * 全部失败 → 抛错(调用方提示手动安装)。
 */
export async function ensureCloudflared(installDir: string): Promise<string> {
  const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";

  const inPath = findInPath(name);
  if (inPath) return inPath;

  const binary = join(installDir, name);
  if (existsSync(binary)) return binary;

  mkdirSync(installDir, { recursive: true });
  const asset = assetName();
  let lastErr: unknown = null;
  for (const url of downloadUrls(asset)) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(binary));
      if (process.platform !== "win32") chmodSync(binary, 0o755);
      return binary;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`cloudflared 下载失败(镜像与官方均失败),请手动安装:${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** 校验 PATH/安装目录里的 cloudflared 可执行(§39.1 已装 → 直接用)。 */
export function checkCloudflaredVersion(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["--version"], (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}
