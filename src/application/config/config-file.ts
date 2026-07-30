// 通用 JSON 配置文件读写 —— application 层。
//
// 框架级配置管理:不针对 settings.json/models.json 专用,而是通用的"读/写任意 JSON 文件"。
// 路径由 shell 注入(~ 已展开为绝对路径),不 import electron。
// 写用 proper-lockfile 防并发撕裂,深合并 or 整份覆盖由 mergeMode 控制。
//
// withDirLock 是各 store 共用的"锁目录 → fn → 释放"原语(消除 5 处重复 lockfile 模板)。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
