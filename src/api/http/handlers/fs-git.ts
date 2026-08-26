// IPC:fs:project + git:read/git:write 声明能力 —— 权限门控 + 路径圈禁在 IPC 边界。
import {} from "electron";
import type { Gateway } from "../../../core/application/remote/gateway";
import { resolve, join, sep } from "node:path";
import { readdirSync } from "node:fs";
import { removePath } from "../../../client/fs/fs-sync";
import { walkDirTree } from "../../../client/fs/fs-tree";
import { readTextFile, readFileAsBase64, createEmptyFile, createSingleDir, renamePath as fsRenamePath, copyPath as fsCopyPath } from "../../../client/fs/fs-ops";
import { repoStatus, fileDiff, fileContent, recentCommits } from "../../../client/git/git-status";
import { commitFiles, pushCurrent } from "../../../client/git/git-write";
import { IPC } from "@my-harness-desktop/shared";
import type { MainContext } from "../../ipc/main-context";

export function registerFsGit(gateway: Gateway, ctx: MainContext): void {
  const { registry, sessionStore } = ctx;

  // ---- 声明能力门控:未在 manifest permissions 声明的插件调用即抛错(registry 统一实现)----
  const assertPermission = (pluginId: string, permission: string): void =>
    registry.assertPermission(pluginId, permission);

  // ---- fs:project 圈禁:路径必须落在当前项目根(sessionStore.activeCwd)内 ----
  // fail-closed:无激活 cwd 时拒绝;resolve + 前缀检查,防 .. 逃逸。
  // 演进:若插件传符号链分子目录,可用 realpath 进一步加固(当前 baseline 前缀检查)。
  function assertProjectPath(raw: string): string {
    const root = sessionStore.getActiveCwd();
    if (!root) throw new Error("fs:project 拒绝:无激活项目目录");
    const abs = resolve(raw.startsWith("~/") ? join(ctx.paths.homeDir, raw.slice(2)) : raw);
    const rootAbs = resolve(root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      throw new Error(`fs:project 越界: ${abs} 不在项目目录 ${rootAbs} 内`);
    }
    return abs;
  }

  // ---- IPC:fs:project 能力(扫目录一层;路径经 assertProjectPath 圈禁到项目根)----
  gateway.register(IPC.fs.listDir, (_e, pluginId: string, cwd: string) => {
    assertPermission(pluginId, "fs:project");
    const abs = assertProjectPath(cwd);
    try {
      const entries = readdirSync(abs, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, isDir: true }));
      const files = entries.filter((e) => e.isFile()).map((e) => ({ name: e.name, isDir: false }));
      const sortFn = (a: { name: string }, b: { name: string }) =>
        a.name.startsWith(".") === b.name.startsWith(".") ? a.name.localeCompare(b.name) : a.name.startsWith(".") ? 1 : -1;
      dirs.sort(sortFn);
      files.sort(sortFn);
      return [...dirs, ...files];
    } catch {
      return [];
    }
  });
  gateway.register(IPC.fs.removePath, (_e, pluginId: string, path: string) => {
    assertPermission(pluginId, "fs:project");
    const abs = assertProjectPath(path);
    removePath(abs);
  });
  gateway.register(IPC.fs.readDirTree, (_e, pluginId: string, cwd: string, opts?: { maxDepth?: number; ignore?: string[] }) => {
    assertPermission(pluginId, "fs:project");
    return walkDirTree(assertProjectPath(cwd), opts ?? {});
  });
  // ---- IPC:fs:project 能力(增删改读;同一权限颗粒,双路径参数逐个圈禁)----
  gateway.register(IPC.fs.readFile, (_e, pluginId: string, path: string) => {
    assertPermission(pluginId, "fs:project");
    return readTextFile(assertProjectPath(path));
  });
  gateway.register(IPC.fs.readFileBase64, (_e, pluginId: string, path: string) => {
    assertPermission(pluginId, "fs:project");
    return readFileAsBase64(assertProjectPath(path));
  });
  gateway.register(IPC.fs.createFile, (_e, pluginId: string, path: string) => {
    assertPermission(pluginId, "fs:project");
    return createEmptyFile(assertProjectPath(path));
  });
  gateway.register(IPC.fs.createDir, (_e, pluginId: string, path: string) => {
    assertPermission(pluginId, "fs:project");
    return createSingleDir(assertProjectPath(path));
  });
  gateway.register(IPC.fs.renamePath, (_e, pluginId: string, from: string, to: string) => {
    assertPermission(pluginId, "fs:project");
    return fsRenamePath(assertProjectPath(from), assertProjectPath(to));
  });
  gateway.register(IPC.fs.copyPath, (_e, pluginId: string, from: string, to: string) => {
    assertPermission(pluginId, "fs:project");
    return fsCopyPath(assertProjectPath(from), assertProjectPath(to));
  });

  // ---- IPC:git:read 能力(右面板 Review 页签数据源;只读)----
  gateway.register(IPC.git.status, async (_e, pluginId: string, cwd: string) => {
    assertPermission(pluginId, "git:read");
    try {
      return await repoStatus(cwd);
    } catch {
      return { isRepo: false, branch: null, ahead: 0, behind: 0, files: [] };
    }
  });
  gateway.register(IPC.git.fileDiff, async (_e, pluginId: string, cwd: string, path: string) => {
    assertPermission(pluginId, "git:read");
    try {
      return await fileDiff(cwd, path);
    } catch {
      return "";
    }
  });
  gateway.register(IPC.git.fileContent, async (_e, pluginId: string, cwd: string, path: string) => {
    assertPermission(pluginId, "git:read");
    try {
      return await fileContent(cwd, path);
    } catch (err) {
      return `读取失败: ${(err as Error).message}`;
    }
  });
  gateway.register(IPC.git.log, async (_e, pluginId: string, cwd: string, limit: number) => {
    assertPermission(pluginId, "git:read");
    try {
      return await recentCommits(cwd, limit);
    } catch {
      return [];
    }
  });

  // ---- IPC:git:write 能力(收敛面:commit/push;路径圈禁在 client/git-write 内)----
  gateway.register(IPC.git.commit, (_e, pluginId: string, cwd: string, message: string, files: string[]) => {
    assertPermission(pluginId, "git:write");
    return commitFiles(cwd, message, files);
  });
  gateway.register(IPC.git.push, (_e, pluginId: string, cwd: string) => {
    assertPermission(pluginId, "git:write");
    return pushCurrent(cwd);
  });
}
