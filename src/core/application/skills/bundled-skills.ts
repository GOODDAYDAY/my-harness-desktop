// 内置 skills 同步 —— application/skills/bundled-skills。
//
// 仓库顶级 .claude/skills/ 随壳分发(与 builtin 插件同模式),启动时镜像到 ~/.pi-desktop/skills
// (强制覆盖,受管目录语义:用户要改请 fork 到自己的 skills 目录),并按 enabled 偏好
// 把源路径条目挂/摘 ~/.pi/agent/settings.json 的 skills[]——挂/摘是总开关的实际控制面
// (底座原生发现机制,零 pi 改动);开关状态本身由 shell 的 prefs 持久,本文件不感知 electron。
// 依据 docs/plugins/skill-manager.md §17。
import { dirname, resolve } from "node:path";
import { writeJsonFile } from "../config/config-file";
import { isOverridePattern, resolvePath } from "./skill-paths";
import { readSettings } from "./skill-toggle";

// 镜像原语收敛到 bundled/mirror(内置 skills 与内置表情包共用),此处 re-export 保持
// mirrorBundledSkills 名字对外不变(bootstrap 与既有调用点零改动)。
export { mirrorManagedDir as mirrorBundledSkills } from "../bundled/mirror";

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
 *  (底座对扫不到的文件忽略),重新挂上后逐 skill 的开关状态原样恢复——
 *  与 removeSkillPath 的清场语义刻意不同(那是"不要这个源",这是"暂时关掉")。 */
export async function ensureBundledSkillsEntry(opts: EnsureBundledEntryOptions): Promise<boolean> {
  const settings = await readSettings(opts.settingsPath);
  const all = (settings.skills as string[]) ?? [];
  // settings 普通条目以所在文件目录为 base 解析(与 scanner 对 user 级条目的解析一致)
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
