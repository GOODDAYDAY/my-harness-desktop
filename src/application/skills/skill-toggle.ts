import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { withDirLock } from "../config/config-file";
import { deepMergeJson } from "../config/json-merge";

function toPosixPath(p: string): string {
  return p.split(require("node:path").sep).join("/");
}

function resolvePath(input: string, baseDir: string): string {
  let p = input.trim();
  if (p.startsWith("~")) p = join(homedir(), p.slice(1));
  if (p.startsWith("/")) return p;
  return join(baseDir, p);
}

function isOverridePattern(s: string): boolean {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

function stripOverridePrefix(s: string): string {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") ? s.slice(1) : s;
}

function getSettingsPath(scope: "user" | "project", agentDir: string, cwd: string): string {
  return scope === "project" ? join(cwd, ".pi", "settings.json") : join(agentDir, "settings.json");
}

function readSettings(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
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
}

export async function toggleSkill(opts: ToggleOptions): Promise<void> {
  const settingsPath = getSettingsPath(opts.scope, opts.agentDir, opts.cwd);
  const baseDir = opts.sourcePath;
  const pattern = toPosixPath(relative(baseDir, opts.filePath));
  if (!pattern) throw new Error("Cannot compute pattern: filePath is not under sourcePath");

  const dir = dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  await withDirLock(dir, async () => {
    const settings = readSettings(settingsPath);
    const current = (settings.skills as string[]) ?? [];
    const filtered = current.filter((entry) => {
      const stripped = stripOverridePrefix(entry);
      return stripped !== pattern;
    });
    const prefix = opts.enabled ? "+" : "-";
    filtered.push(`${prefix}${pattern}`);
    settings.skills = filtered;
    const merged = deepMergeJson(readSettings(settingsPath), { skills: filtered });
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf-8");
  });
}

export interface AddPathOptions {
  path: string;
  scope: "user" | "project";
  agentDir: string;
  cwd: string;
}

export async function addSkillPath(opts: AddPathOptions): Promise<void> {
  const resolved = resolvePath(opts.path, opts.scope === "project" ? opts.cwd : opts.agentDir);
  if (!existsSync(resolved)) throw new Error(`路径不存在: ${resolved}`);

  const settingsPath = getSettingsPath(opts.scope, opts.agentDir, opts.cwd);
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  await withDirLock(dir, async () => {
    const settings = readSettings(settingsPath);
    const current = (settings.skills as string[]) ?? [];
    const alreadyExists = current.some((entry) => {
      const stripped = stripOverridePrefix(entry);
      return resolvePath(stripped, opts.scope === "project" ? opts.cwd : opts.agentDir) === resolved;
    });
    if (alreadyExists) throw new Error(`路径已存在: ${opts.path}`);
    current.push(opts.path.trim());
    const merged = deepMergeJson(readSettings(settingsPath), { skills: current });
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf-8");
  });
}

export interface RemovePathOptions {
  path: string;
  scope: "user" | "project";
  agentDir: string;
  cwd: string;
}

export async function removeSkillPath(opts: RemovePathOptions): Promise<void> {
  const resolved = resolvePath(opts.path, opts.scope === "project" ? opts.cwd : opts.agentDir);
  const settingsPath = getSettingsPath(opts.scope, opts.agentDir, opts.cwd);
  const dir = dirname(settingsPath);

  await withDirLock(dir, async () => {
    const settings = readSettings(settingsPath);
    const current = (settings.skills as string[]) ?? [];
    const filtered = current.filter((entry) => {
      if (isOverridePattern(entry)) {
        const stripped = stripOverridePrefix(entry);
        const strippedResolved = resolvePath(stripped, opts.scope === "project" ? opts.cwd : opts.agentDir);
        return !strippedResolved.startsWith(resolved);
      }
      const entryResolved = resolvePath(entry, opts.scope === "project" ? opts.cwd : opts.agentDir);
      return entryResolved !== resolved;
    });
    settings.skills = filtered;
    const merged = deepMergeJson(readSettings(settingsPath), { skills: filtered });
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf-8");
  });
}
