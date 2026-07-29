import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { readJsonFile, writeJsonFile } from "../config/config-file";
import { toPosixPath, resolvePath, isOverridePattern, stripOverridePrefix } from "./skill-paths";

function getSettingsPath(scope: "user" | "project", agentDir: string, cwd: string): string {
  return scope === "project" ? join(cwd, ".pi", "settings.json") : join(agentDir, "settings.json");
}

/** 读 settings.json(不存在/损坏返回空对象;经共享原语 readJsonFile,不手写 readFileSync)。 */
async function readSettings(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) return {};
  try {
    return await readJsonFile(filePath);
  } catch {
    return {};
  }
}

export interface ToggleOptions {
  filePath: string;
  sourcePath: string;
  enabled: boolean;
  scope: "user" | "project";
  agentDir: string;
  cwd: string;
  homeDir: string;
}

export async function toggleSkill(opts: ToggleOptions): Promise<void> {
  const settingsPath = getSettingsPath(opts.scope, opts.agentDir, opts.cwd);
  const baseDir = opts.sourcePath;
  const pattern = toPosixPath(relative(baseDir, opts.filePath));
  if (!pattern) throw new Error("Cannot compute pattern: filePath is not under sourcePath");

  // writeJsonFile 已含 withDirLock + deepMergeJson(deep 模式),不手写 read+lock+write(收敛 §9.1)。
  const settings = await readSettings(settingsPath);
  const current = (settings.skills as string[]) ?? [];
  const filtered = current.filter((entry) => stripOverridePrefix(entry) !== pattern);
  filtered.push(`${opts.enabled ? "+" : "-"}${pattern}`);
  await writeJsonFile(settingsPath, { skills: filtered }, "deep");
}

export interface AddPathOptions {
  path: string;
  scope: "user" | "project";
  agentDir: string;
  cwd: string;
  homeDir: string;
}

export async function addSkillPath(opts: AddPathOptions): Promise<void> {
  const base = opts.scope === "project" ? opts.cwd : opts.agentDir;
  const resolved = resolvePath(opts.path, base, opts.homeDir);
  if (!existsSync(resolved)) throw new Error(`路径不存在: ${resolved}`);

  const settingsPath = getSettingsPath(opts.scope, opts.agentDir, opts.cwd);
  const settings = await readSettings(settingsPath);
  const current = (settings.skills as string[]) ?? [];
  const alreadyExists = current.some((entry) => {
    const stripped = stripOverridePrefix(entry);
    return resolvePath(stripped, base, opts.homeDir) === resolved;
  });
  if (alreadyExists) throw new Error(`路径已存在: ${opts.path}`);
  current.push(opts.path.trim());
  await writeJsonFile(settingsPath, { skills: current }, "deep");
}

export interface RemovePathOptions {
  path: string;
  scope: "user" | "project";
  agentDir: string;
  cwd: string;
  homeDir: string;
}

export async function removeSkillPath(opts: RemovePathOptions): Promise<void> {
  const base = opts.scope === "project" ? opts.cwd : opts.agentDir;
  const resolved = resolvePath(opts.path, base, opts.homeDir);
  const settingsPath = getSettingsPath(opts.scope, opts.agentDir, opts.cwd);
  const settings = await readSettings(settingsPath);
  const current = (settings.skills as string[]) ?? [];
  const filtered = current.filter((entry) => {
    if (isOverridePattern(entry)) {
      const stripped = stripOverridePrefix(entry);
      const strippedResolved = resolvePath(stripped, base, opts.homeDir);
      return !strippedResolved.startsWith(resolved);
    }
    const entryResolved = resolvePath(entry, base, opts.homeDir);
    return entryResolved !== resolved;
  });
  await writeJsonFile(settingsPath, { skills: filtered }, "deep");
}
