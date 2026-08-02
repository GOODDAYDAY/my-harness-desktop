import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { readJsonFile, withDirLock, writeJsonFile } from "../config/config-file";
import { toPosixPath, resolvePath, isOverridePattern, stripOverridePrefix } from "./skill-paths";
import { scanSkills } from "./skill-scanner";

function getSettingsPath(scope: "user" | "project", agentDir: string, cwd: string): string {
  return scope === "project" ? join(cwd, ".pi", "settings.json") : join(agentDir, "settings.json");
}

/** 读 settings.json(不存在/损坏返回空对象;经共享原语 readJsonFile,不手写 readFileSync)。
 *  与 scanner 的 readSettingsJson 同一语义两处实现(同步/异步各一,锚定注释见 scanner);
 *  bundled-skills 复用本份,不再开第三份拷贝。 */
export async function readSettings(filePath: string): Promise<Record<string, unknown>> {
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

/** 手术式改 frontmatter 单字段:保留注释、字段顺序与 body 原文空白(不整体重排 YAML、
 *  不 trim body),只动目标行或插入一行。根因:旧实现 stringifyYaml 整体重写 frontmatter
 *  丢注释+字段重排,parseFrontmatter 的 trim 还吃 body 首尾空白(评估 M 项)。 */
function setFrontmatterField(content: string, key: string, value: string): string {
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  if (!content.startsWith("---")) {
    return `---${nl}${key}: ${value}${nl}---${nl}${nl}${content}`;
  }
  const openEnd = content.indexOf(nl, 0) + nl.length;
  let closeIdx = content.indexOf(`${nl}---`, openEnd - nl.length);
  if (closeIdx === -1) {
    // 未闭合 fence:按无 frontmatter 处理,前置一个合法块
    return `---${nl}${key}: ${value}${nl}---${nl}${nl}${content}`;
  }
  if (content[closeIdx - 1] === "\r") closeIdx -= 1; // \r 归 fence 侧
  const block = content.slice(openEnd, closeIdx);
  const fieldRe = new RegExp(`(^|\\n)([ \\t]*${key}[ \\t]*:[^\\n\\r]*)`);
  const m = block.match(fieldRe);
  if (m && m.index !== undefined && m[1] !== undefined) {
    return (
      content.slice(0, openEnd + m.index) +
      m[1] +
      m[0].slice(m[1].length).replace(/:.*/u, `: ${value}`) +
      content.slice(openEnd + m.index + m[0].length)
    );
  }
  return content.slice(0, closeIdx) + `${nl}${key}: ${value}` + content.slice(closeIdx);
}

export async function toggleForceInvocation(opts: ToggleForceOptions): Promise<void> {
  // withDirLock 串行化:与 settings 写路径同一条锁原语,杜绝并发改同一 SKILL.md 撕裂。
  await withDirLock(dirname(opts.filePath), async () => {
    const content = await readFile(opts.filePath, "utf-8");
    const next = setFrontmatterField(content, "disable-model-invocation", String(!opts.force));
    await writeFile(opts.filePath, next, "utf-8");
  });
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

  // 根因修复:toggle 写入的 +/- 模式条目是相对 sourcePath 的 posix 路径(如 “my-skill/SKILL.md”),无法
  // 从字符串反推绝对路径去 startsWith 匹配——必须先扫出该源下的 skills 算出 pattern 集合再过滤,
  // 与 toggleSkill 的写入方向对偶(docs/plugins/skill-manager.md §5.3)。源已不存在则扫不出,
  // 该源的残留模式条目按底座语义无害(文件不存在被忽略),留待用户在 settings 里手工清。
  const patterns = new Set<string>();
  if (existsSync(resolved)) {
    // 一个 skill 可能经多条路径被发现(symbolic links / /tmp→/private/tmp 这类系统级链接),
    // 必须同时收两种 pattern:原始路径相对值,和 realpath 规范化后的相对路径,
    // 否则 toggle 从哪条路径写入的 pattern 对不上号,条目残留。
    let realSource = resolved;
    try { realSource = realpathSync(resolved); } catch { /* keep raw */ }
    for (const s of scanSkills({ agentDir: opts.agentDir, cwd: opts.cwd, homeDir: opts.homeDir })) {
      if (s.scope !== opts.scope) continue;
      if (s.filePath === resolved) {
        patterns.add(basename(s.filePath)); // 单文件源:pattern 即 basename(与 toggleSkill 退化分支一致)
      } else if (s.sourcePath === resolved) {
        patterns.add(toPosixPath(relative(resolved, s.filePath)));
        try { patterns.add(toPosixPath(relative(realSource, realpathSync(s.filePath)))); } catch { /* keep raw */ }
      }
    }
  }

  const filtered = current.filter((entry) => {
    if (isOverridePattern(entry)) return !patterns.has(stripOverridePrefix(entry));
    return resolvePath(entry, base, opts.homeDir) !== resolved;
  });
  await writeJsonFile(settingsPath, { skills: filtered }, "deep");
}
