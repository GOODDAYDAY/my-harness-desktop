// Git 工作区变更 —— application 层(能力实现,经 permissions "git:read" 门控后给插件)。
//
// simple-git 包装:cwd 由 shell 注入,不 import electron。只读(status/diff/content)。
import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { simpleGit } from "simple-git";

/** 变更文件条目(status:M/A/D/R 等,未跟踪记 "?" 供 UI 区分)。 */
export interface GitChangedFile {
  path: string;
  status: string;
}

/** status:非 repo 抛错(调用方捕获返回 isRepo=false)。staged 优先,未跟踪 "?"。 */
export async function listChangedFiles(cwd: string): Promise<GitChangedFile[]> {
  const git = simpleGit(cwd);
  const s = await git.status();
  return s.files.map((f) => ({
    path: f.path,
    status: f.index === "?" ? "?" : f.index.trim() || f.working_dir.trim() || "M",
  }));
}

/** 单文件相对 HEAD 的 unified diff(staged+unstaged 合并)。未跟踪文件返回空串。 */
export async function fileDiff(cwd: string, path: string): Promise<string> {
  const git = simpleGit(cwd);
  return git.diff(["HEAD", "--", path]);
}

/** 读未跟踪文件内容(新建文件无 diff 可显示)。限 cwd 子树内 + 200KB,防路径逃逸。 */
export async function fileContent(cwd: string, path: string): Promise<string> {
  const abs = normalize(join(cwd, path));
  if (!abs.startsWith(normalize(cwd) + sep)) throw new Error(`路径逃逸: ${path}`);
  const buf = await readFile(abs);
  if (buf.byteLength > 200 * 1024) throw new Error(`文件过大(>200KB): ${path}`);
  return buf.toString("utf-8");
}
