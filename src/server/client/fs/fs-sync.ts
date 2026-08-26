// 同步 fs 原语 —— 会话文件/快照复制删除用。与 fs-ops.ts(async、fs:project IPC 实现)分工:
// 本文件是同步 fs(copyFileSync/rmSync/mkdirSync),服务 pi 会话存储层(pi-catalog)与
// api/ipc 的通用删除——同步是刻意取舍:会话文件大、写链路上锁原语需要同步语义,简单可靠。
import { copyFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** 删除文件或目录(递归);force=true 对不存在路径静默成功。 */
export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** 复制单个文件,目标父目录不存在时自动创建;源不存在抛错。 */
export function copyFileWithDir(srcPath: string, targetPath: string): void {
  if (!existsSync(srcPath)) throw new Error(`源文件不存在: ${srcPath}`);
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  copyFileSync(srcPath, targetPath);
}
