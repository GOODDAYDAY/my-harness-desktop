// fs-ops.ts —— 项目目录内的文件增删改读(fs:createFile/createDir/renamePath/copyPath/readFile IPC 的实现函数)。
//
// 分层归属:纯执行函数,不做权限门控、不做路径圈禁(都在 IPC 边界做),也不关心调用方是谁。
// 统一"已存在即抛错"的拒绝语义:文件管理器语义下静默覆盖是事故,冲突交给调用方提示。
import { promises as fsp } from "node:fs";

const READ_FILE_MAX_BYTES = 1024 * 1024;
const READ_FILE_BASE64_MAX_BYTES = 25 * 1024 * 1024;

/** 读文本文件全文(utf8);超过 1MB 抛错(盲审等场景全文进 prompt,大文件无意义)。 */
export async function readTextFile(abs: string): Promise<string> {
  const stat = await fsp.stat(abs);
  if (!stat.isFile()) throw new Error(`不是文件: ${abs}`);
  if (stat.size > READ_FILE_MAX_BYTES) throw new Error(`文件过大(${Math.ceil(stat.size / 1024)}KB),超过 1MB 上限`);
  return fsp.readFile(abs, "utf8");
}

/** 读文件为 base64;超过 25MB 抛错(图片/pdf 预览用,mime 由调用方按扩展名定——内核不持 mime 表)。 */
export async function readFileAsBase64(abs: string): Promise<string> {
  const stat = await fsp.stat(abs);
  if (!stat.isFile()) throw new Error(`不是文件: ${abs}`);
  if (stat.size > READ_FILE_BASE64_MAX_BYTES) throw new Error(`文件过大(${Math.ceil(stat.size / 1024 / 1024)}MB),超过 25MB 上限`);
  return (await fsp.readFile(abs)).toString("base64");
}

/** 新建空文件;wx 旗标:已存在抛 EEXIST,不静默覆盖。父目录必须存在(不递归建目录)。 */
export async function createEmptyFile(abs: string): Promise<void> {
  const handle = await fsp.open(abs, "wx");
  await handle.close();
}

/** 新建单层目录;recursive: false——已存在或父级缺失都抛错,不静默兼容。 */
export async function createSingleDir(abs: string): Promise<void> {
  await fsp.mkdir(abs, { recursive: false });
}

async function assertNotExists(abs: string): Promise<void> {
  try {
    await fsp.access(abs);
  } catch {
    return;
  }
  throw new Error(`目标已存在: ${abs}`);
}

/** 重命名/移动;POSIX rename 对文件会静默覆盖同名目标,先挡掉。 */
export async function renamePath(from: string, to: string): Promise<void> {
  await assertNotExists(to);
  await fsp.rename(from, to);
}

/** 复制文件或目录(目录递归);force:false + errorOnExist:true——已存在抛错。 */
export async function copyPath(from: string, to: string): Promise<void> {
  await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true });
}
