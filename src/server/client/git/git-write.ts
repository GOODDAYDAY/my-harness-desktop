// Git 写操作 —— 收敛面只有 commit 和 push(经 permissions "git:write" 门控后给插件)。
//
// 安全收敛:files 逐个校验为 cwd 内相对路径(防路径逃逸);message 只作 simple-git
// 参数数组元素传递,永不拼进 shell 字符串;push 无参(当前分支→upstream,无 force)。
import { normalize, sep } from "node:path";
import { simpleGit } from "simple-git";

function assertRelativePaths(cwd: string, files: string[]): void {
  if (files.length === 0) throw new Error("commit 拒绝:未选择文件");
  const root = normalize(cwd) + sep;
  for (const f of files) {
    const abs = normalize(`${root}${f}`);
    if (!abs.startsWith(root)) throw new Error(`路径逃逸: ${f}`);
  }
}

/** add 指定文件 + pathspec 限定 commit(只提交 files,不卷入此前已暂存的其他文件)。
 *  add 是为未跟踪文件(pathspec commit 对新文件报错);tracked 文件由 pathspec commit 直接带工作区内容。 */
export async function commitFiles(
  cwd: string,
  message: string,
  files: string[],
): Promise<{ ok: boolean; hash?: string; error?: string }> {
  try {
    if (!message.trim()) throw new Error("commit 拒绝:message 为空");
    assertRelativePaths(cwd, files);
    const git = simpleGit(cwd);
    await git.add(files);
    const r = await git.commit(message, files);
    return { ok: true, hash: r.commit || undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** push 当前分支到已配置 upstream。无 upstream 时 simple-git 报错原样返回,不自动 publish。 */
export async function pushCurrent(cwd: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await simpleGit(cwd).push();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
