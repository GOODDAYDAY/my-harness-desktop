import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { readJsonFile, writeJsonFile } from "../config/config-file";
import { toPosixPath, resolvePath, isOverridePattern, stripOverridePrefix } from "./skill-paths";
import { parseFrontmatter } from "./skill-scanner";

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
  // sourcePath 可能是目录也可能是文件(settings.json 两种声明形态)。文件源时 scanner 已把
  // sourcePath 归一到 dirname(H-1 修复);这里仍做防御:旧数据/直调 IPC 传入文件路径时,
  // relative 得空串会丢错,退化为 basename 作为 pattern,与 scanner 的归一结果一致。
  const baseDir = opts.sourcePath;
  let pattern = toPosixPath(relative(baseDir, opts.filePath));
  if (!pattern) pattern = basename(opts.filePath);

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

export interface ToggleForceOptions {
  filePath: string;
  force: boolean;
}

export async function toggleForceInvocation(opts: ToggleForceOptions): Promise<void> {
  const content = readFileSync(opts.filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);
  frontmatter["disable-model-invocation"] = !opts.force;
  const yamlStr = stringifyYaml(frontmatter).trim();
  const newContent = `---\n${yamlStr}\n---\n\n${body}`;
  writeFileSync(opts.filePath, newContent, "utf-8");
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
