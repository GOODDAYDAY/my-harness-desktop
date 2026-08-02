// Git 工作区变更 —— application 层(能力实现,经 permissions "git:read" 门控后给插件)。
//
// simple-git 包装:cwd 由 shell 注入,不 import electron。只读(status/diff/content/log)。
import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { simpleGit } from "simple-git";
import type { GitChangedFile, GitLogEntry, GitStatusResult } from "../../core/domain/sessions";

/** status:非 repo 抛错(调用方捕获返回 isRepo=false)。双码直出 simple-git 的 index/working_dir。 */
export async function repoStatus(cwd: string): Promise<GitStatusResult> {
  const s = await simpleGit(cwd).status();
  const files: GitChangedFile[] = s.files.map((f) => ({
    path: f.path,
    index: f.index,
    worktree: f.working_dir,
  }));
  return { isRepo: true, branch: s.current, ahead: s.ahead, behind: s.behind, files };
}

/** 单文件相对 HEAD 的 unified diff(staged+unstaged 合并)。未跟踪文件返回空串。 */
export async function fileDiff(cwd: string, path: string): Promise<string> {
  const git = simpleGit(cwd);
  return git.diff(["HEAD", "--", path]);
}

/** 最近 N 条提交(commit 后确认落点用)。非 repo/空历史抛错,调用方捕获。 */
export async function recentCommits(cwd: string, limit: number): Promise<GitLogEntry[]> {
  const r = await simpleGit(cwd).log({ maxCount: Math.max(1, Math.min(limit, 100)) });
  return r.all.map((c) => ({
    hash: c.hash,
    message: c.message,
    author: c.author_name,
    timestamp: Date.parse(c.date),
  }));
}

/** 读未跟踪文件内容(新建文件无 diff 可显示)。限 cwd 子树内 + 200KB,防路径逃逸。 */
export async function fileContent(cwd: string, path: string): Promise<string> {
  const abs = normalize(join(cwd, path));
  if (!abs.startsWith(normalize(cwd) + sep)) throw new Error(`路径逃逸: ${path}`);
  const buf = await readFile(abs);
  if (buf.byteLength > 200 * 1024) throw new Error(`文件过大(>200KB): ${path}`);
  return buf.toString("utf-8");
}
