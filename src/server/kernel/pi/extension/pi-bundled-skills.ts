// pi-bundled-skills —— pi 内核的「内置/插件 skills 目录挂载」适配器。
//
// 之前这些逻辑在 core/application/skills/bundled-skills.ts(壳层),直接读写 pi 的
// settings.json skills[](pi 专属存储格式)。现下沉到 client/pi,壳(bootstrap/api)经此
// 挂/摘目录、迁移旧路径,不碰 pi settings.json 形状。与 pi-skill-provider 同层:
// 内核适配器读/写自己的存储,合法;壳不碰。
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJsonFile, writeJsonFile } from "../../../application/config/config-file";

function readSettings(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return readJsonFile(filePath);
  } catch {
    return {};
  }
}

function resolvePath(input: string, baseDir: string, homeDir: string): string {
  let p = input.trim();
  if (p.startsWith("~")) p = join(homeDir, p.slice(1));
  if (p.startsWith("/")) return resolve(p);
  return resolve(baseDir, p);
}

function isOverridePattern(s: string): boolean {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

function stripOverridePrefix(s: string): string {
  return isOverridePattern(s) ? s.slice(1) : s;
}

export interface EnsureBundledEntryOptions {
  /** user 级 settings 路径(~/.pi/agent/settings.json,shell 注入)。 */
  settingsPath: string;
  /** 受管目录绝对路径(挂进 skills[] 的普通条目值)。 */
  targetDir: string;
  enabled: boolean;
  homeDir: string;
}

/** 按 enabled 挂/摘 settings.json skills[] 的内置源路径条目;返回是否发生了写入
 *  (供 shell 决定要不要广播 settings:changed)。条目比对经 resolvePath 归一,
 *  ~ 拼写/相对拼写不重复挂。摘时不清该源下 skills 的 +/- 模式条目:残留无害
 *  (内核对扫不到的文件忽略),重新挂上后逐 skill 的开关状态原样恢复。 */
export async function ensureBundledSkillsEntry(opts: EnsureBundledEntryOptions): Promise<boolean> {
  const settings = await readSettings(opts.settingsPath);
  const all = (settings.skills as string[]) ?? [];
  const base = dirname(opts.settingsPath);
  const target = resolve(opts.targetDir);
  const isOurs = (e: string) => !isOverridePattern(e) && resolvePath(e, base, opts.homeDir) === target;
  const present = all.some(isOurs);
  if (opts.enabled === present) return false;
  const next = opts.enabled ? [...all, target] : all.filter((e) => !isOurs(e));
  await writeJsonFile(opts.settingsPath, { skills: next }, "deep");
  return true;
}

export interface EnsurePluginSkillsEntryOptions {
  settingsPath: string;
  skillsDir: string;
  active: boolean;
  homeDir: string;
}

export async function ensurePluginSkillsEntry(opts: EnsurePluginSkillsEntryOptions): Promise<boolean> {
  const settings = await readSettings(opts.settingsPath);
  const all = (settings.skills as string[]) ?? [];
  const base = dirname(opts.settingsPath);
  const target = resolve(opts.skillsDir);
  const isOurs = (e: string) => !isOverridePattern(e) && resolvePath(e, base, opts.homeDir) === target;
  const present = all.some(isOurs);
  if (opts.active === present) return false;
  const next = opts.active ? [...all, target] : all.filter((e) => !isOurs(e));
  await writeJsonFile(opts.settingsPath, { skills: next }, "deep");
  return true;
}

/** 改名迁移:pi-desktop → my-harness-desktop 时,settings.json skills[] 里指向旧数据根
 *  (~/.pi-desktop、~/.pi-desktop-dev)前缀的 +/- 绝对路径条目重写到新数据根。
 *  幂等:迁移后不再有 /.pi-desktop 前缀,重跑无副作用。 */
export async function migrateLegacySkillPatterns(settingsPath: string): Promise<boolean> {
  const settings = await readSettings(settingsPath);
  const all = (settings.skills as string[]) ?? [];
  let changed = false;
  const next = all.map((entry) => {
    if (!isOverridePattern(entry)) return entry;
    const stripped = stripOverridePrefix(entry);
    if (!stripped.includes("/.pi-desktop")) return entry;
    changed = true;
    return entry[0] + stripped.replace("/.pi-desktop", "/.my-harness-desktop");
  });
  if (changed) await writeJsonFile(settingsPath, { skills: next }, "deep");
  return changed;
}
