import { existsSync, renameSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import * as tar from "node:tar";
import type { PluginManifest } from "../../domain/contributions";
import type { DiscoveredPlugin } from "../loader/discover";

export interface InstallSource {
  resolve(): Promise<Buffer>;
  describe(): string;
}

export class UrlSource implements InstallSource {
  constructor(private url: string) {}
  async resolve(): Promise<Buffer> {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }
  describe(): string {
    return `URL: ${this.url}`;
  }
}

export class LocalFileSource implements InstallSource {
  constructor(private path: string) {}
  async resolve(): Promise<Buffer> {
    const { readFileSync } = await import("node:fs");
    return readFileSync(this.path);
  }
  describe(): string {
    return `本地文件: ${this.path}`;
  }
}

function isTarGz(buf: Buffer): boolean {
  return buf[0] === 0x1f && buf[1] === 0x8b;
}

function isZip(buf: Buffer): boolean {
  return buf[0] === 0x50 && buf[1] === 0x4b;
}

async function extractArchive(buf: Buffer, targetDir: string): Promise<void> {
  mkdirSync(targetDir, { recursive: true });
  if (isTarGz(buf)) {
    await tar.x({
      file: undefined,
      cwd: targetDir,
      onentry: undefined,
    } as never).then(async () => {
      const gunzip = zlib.createGunzip();
      const extract = tar.x({ cwd: targetDir });
      await pipeline(Readable.from([buf]), gunzip, extract);
    }).catch(async () => {
      const gunzip = zlib.createGunzip();
      const extract = tar.x({ cwd: targetDir });
      await pipeline(Readable.from([buf]), gunzip, extract);
    });
  } else if (isZip(buf)) {
    throw new Error("ZIP 格式暂不支持，请使用 .tar.gz");
  } else {
    throw new Error("未知的压缩格式（magic bytes 不匹配 tar.gz 或 zip）");
  }
}

async function cleanup(dir: string): Promise<void> {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export interface InstallResult {
  ok: boolean;
  error: string | null;
  manifest?: PluginManifest;
  pluginPath?: string;
}

export async function install(
  source: InstallSource,
  installedDir: string,
): Promise<InstallResult> {
  let buf: Buffer;
  try {
    buf = await source.resolve();
  } catch (e) {
    return { ok: false, error: `获取失败: ${(e as Error).message}` };
  }

  const tmpDir = join(installedDir, `.tmp-${Date.now()}`);
  try {
    await extractArchive(buf, tmpDir);
  } catch (e) {
    await cleanup(tmpDir);
    return { ok: false, error: `解压失败: ${(e as Error).message}` };
  }

  const manifestPath = join(tmpDir, "plugin.json");
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
  } catch {
    await cleanup(tmpDir);
    return { ok: false, error: "plugin.json 不存在或格式错误" };
  }

  const targetDir = join(installedDir, manifest.id);
  if (existsSync(targetDir)) {
    await cleanup(tmpDir);
    return { ok: false, error: `插件 ${manifest.id} 已存在，需先卸载旧版` };
  }

  renameSync(tmpDir, targetDir);

  return { ok: true, error: null, manifest, pluginPath: targetDir };
}
