// 通用 JSON 配置文件读写 + JSONL 追加原语 —— application 层。
//
// 框架级配置管理:不针对 settings.json/models.json 专用,而是通用的"读/写任意 JSON 文件"。
// 路径由 shell 注入(~ 已展开为绝对路径),不 import electron。
// 写用 proper-lockfile 防并发撕裂,深合并 or 整份覆盖由 mergeMode 控制。
//
// withDirLock 是各 store 共用的"锁目录 → fn → 释放"原语(消除 5 处重复 lockfile 模板)。
// appendJsonlLine 是 JSONL 追加原语(同一把目录锁,尾字节补换行),服务 session 文件等
// append-only 文件;条目形状是内容层的事,原语中性(设计:docs/design/session-jsonl-append.md)。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as lockfile from "proper-lockfile";
import { deepMergeJson } from "./json-merge";

/**
 * 锁目录执行 fn,串行化并发写(proper-lockfile,stale 5s)。
 * 锁目录而非文件:首次写时文件可能不存在,锁文件会 ENOENT;锁已 mkdir 的目录最稳。
 * config-store/models-store/pi-settings-store/session-scanner 共用此原语,不各写一遍。
 */
export async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(dir, {
      stale: 5000,
      retries: { retries: 3, factor: 2, minTimeout: 100, maxTimeout: 500, randomize: true },
    });
    return await fn();
  } finally {
    if (release) await release();
  }
}

/** 读 JSON 文件。不存在/损坏返回空对象。 */
export function readJsonFile(absPath: string): Record<string, unknown> {
  if (!existsSync(absPath)) return {};
  try {
    return JSON.parse(readFileSync(absPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 读白名单内文件为 base64(不存在返回 null)。banner 等二进制资源的通用读取原语,与 readJsonFile 并列。 */
export function readBinaryFile(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath).toString("base64");
}

/** 写二进制文件:base64 解码后落盘(盘上存原始二进制,不是 base64 文本),目录递归创建,同一把目录锁。 */
export async function writeBinaryFile(absPath: string, base64: string): Promise<void> {
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await withDirLock(dir, async () => {
    await writeFile(absPath, Buffer.from(base64, "base64"));
  });
}

/** 写 JSON 文件。mergeMode=deep 深合并,replace 整份覆盖。文件锁串行化。 */
export async function writeJsonFile(
  absPath: string,
  data: Record<string, unknown>,
  mergeMode: "deep" | "replace" = "replace",
): Promise<void> {
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await withDirLock(dir, async () => {
    const toWrite = mergeMode === "deep" ? deepMergeJson(readJsonFile(absPath), data) : data;
    await writeFile(absPath, JSON.stringify(toWrite, null, 2), "utf-8");
  });
}

/**
 * 追加一行 JSONL。与 writeJsonFile/updateSessionHeader 同一把目录锁串行;
 * 文件尾无换行先补换行(修复崩溃残留的撕裂尾);文件不存在则创建(对齐 writeJsonFile 创建语义)。
 * entry 开放形状——原语中性,条目形状(custom_message 等)是内容层的事。
 * 序列化不带缩进:一行一条是 JSONL 的格式语义(对照 writeJsonFile 的 null,2)。
 */
export async function appendJsonlLine(absPath: string, entry: Record<string, unknown>): Promise<void> {
  // 先序列化:不可序列化(循环引用/BigInt)在拿锁前抛错,不占锁
  const line = JSON.stringify(entry) + "\n";
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await withDirLock(dir, async () => {
    let prefix = "";
    if (existsSync(absPath)) {
      const size = statSync(absPath).size;
      if (size > 0) {
        // 读尾 1 字节判断换行边界(同步 syscall,照 readSessionToolConfig 读头 8KB 的手法,不整读)
        const fd = openSync(absPath, "r");
        try {
          const tail = Buffer.alloc(1);
          readSync(fd, tail, 0, 1, size - 1);
          if (tail[0] !== 0x0a) prefix = "\n"; // 0x0a = "\n"
        } finally {
          closeSync(fd);
        }
      }
    }
    await appendFile(absPath, prefix + line, "utf-8");
  });
}
