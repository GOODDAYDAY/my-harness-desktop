import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillInfo, ScanOptions } from "../../domain/skills";
import { toPosixPath, resolvePath, isOverridePattern } from "./skill-paths";

// 发现不读 .gitignore/.ignore/.fdignore（方案 B，2024-xx 评估）：pi 底座 core/skills.ts
// 用 ignore 规则过滤技能，是把"哪些进 git"的版本控制语义误当"哪些技能生效"的语义；
// 管理界面要展示的是"目录里真实存在的全部技能"，与 pi 加载策略解耦，settings 显式声明的
// 源路径同理全量扫。根因：~/.claude/skills/.gitignore 用 `/*/`+白名单做 git 跟踪控制，
// 复用后 9 个本地技能在管理页凭空消失。硬排除只留 .开头目录和 node_modules（避免失控递归）。

interface ParsedSkill {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  try {
    const parsed = parseYaml(yamlString) ?? {};
    return { frontmatter: parsed as Record<string, unknown>, body };
  } catch {
    return { frontmatter: {}, body };
  }
}

function loadSkillFromFile(filePath: string): ParsedSkill | null {
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter(rawContent);
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);
    const name = (frontmatter.name as string) || parentDirName;
    const description = (frontmatter.description as string) ?? "";
    if (!description || description.trim() === "") return null;
    return {
      name,
      description,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    };
  } catch {
    return null;
  }
}

type SkillMode = "pi" | "agents";

function collectSkillEntries(
  dir: string,
  mode: SkillMode,
  root: string,
): string[] {
  const entries: string[] = [];
  if (!existsSync(dir)) return entries;
  try {
    const dirEntries = readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name !== "SKILL.md") continue;
      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { isFile = statSync(fullPath).isFile(); } catch { continue; }
      }
      if (isFile) {
        entries.push(fullPath);
        return entries;
      }
    }
    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDir = stats.isDirectory();
          isFile = stats.isFile();
        } catch { continue; }
      }
      // pi 模式:源根目录的裸 .md 当成单文件技能。排除 README*——目录说明文档(常带
      // frontmatter description 会被收留)不是技能,否则每个源目录冒出名为 "skills" 的幽灵条目。
      if (mode === "pi" && dir === root && isFile && entry.name.endsWith(".md") && !/^readme/i.test(entry.name)) {
        entries.push(fullPath);
        continue;
      }
      if (!isDir) continue;
      entries.push(...collectSkillEntries(fullPath, mode, root));
    }
  } catch { /* ignore */ }
  return entries;
}

interface SkillEntry {
  filePath: string;
  sourcePath: string;
  sourceType: "settings" | "auto";
  scope: "user" | "project";
}

function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
  const plain: string[] = [];
  const patterns: string[] = [];
  for (const entry of entries) {
    if (isOverridePattern(entry)) patterns.push(entry);
    else plain.push(entry);
  }
  return { plain, patterns };
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
  const overrides = patterns.filter(isOverridePattern);
  const excludes = overrides.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const forceIncludes = overrides.filter((p) => p.startsWith("+")).map((p) => p.slice(1));
  const forceExcludes = overrides.filter((p) => p.startsWith("-")).map((p) => p.slice(1));
  const rel = toPosixPath(relative(baseDir, filePath));
  let enabled = true;
  if (excludes.length > 0 && matchesAny(rel, excludes)) enabled = false;
  if (forceIncludes.length > 0 && matchesExact(rel, forceIncludes)) enabled = true;
  if (forceExcludes.length > 0 && matchesExact(rel, forceExcludes)) enabled = false;
  return enabled;
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.includes("*") || p.includes("?")) {
      return globMatch(p, filePath);
    }
    return filePath === p || filePath.startsWith(p.endsWith("/") ? p : `${p}/`);
  });
}

function matchesExact(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => filePath === p);
}

function globMatch(pattern: string, path: string): boolean {
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(path);
}

function findGitRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
  const skillDirs: string[] = [];
  const resolvedStartDir = resolve(startDir);
  const gitRepoRoot = findGitRepoRoot(resolvedStartDir);
  let dir = resolvedStartDir;
  while (true) {
    skillDirs.push(join(dir, ".agents", "skills"));
    if (gitRepoRoot && dir === gitRepoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return skillDirs;
}

export function scanSkills(opts: ScanOptions): SkillInfo[] {
  const { agentDir, cwd } = opts;
  const globalSettingsPath = join(agentDir, "settings.json");
  const globalSettings = existsSync(globalSettingsPath)
    ? JSON.parse(readFileSync(globalSettingsPath, "utf-8")) as Record<string, unknown>
    : {};
  const globalSkillsEntries = (globalSettings.skills as string[]) ?? [];
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  const projectSettings = existsSync(projectSettingsPath)
    ? JSON.parse(readFileSync(projectSettingsPath, "utf-8")) as Record<string, unknown>
    : {};
  const projectSkillsEntries = (projectSettings.skills as string[]) ?? [];

  const allEntries: SkillEntry[] = [];
  const seen = new Set<string>();

  const addEntries = (filePaths: string[], sourcePath: string, sourceType: "settings" | "auto", scope: "user" | "project") => {
    for (const fp of filePaths) {
      const real = (() => { try { return realpathSync(fp); } catch { return fp; } })();
      if (seen.has(real)) continue;
      seen.add(real);
      allEntries.push({ filePath: fp, sourcePath, sourceType, scope });
    }
  };

  const { plain: globalPlain, patterns: globalPatterns } = splitPatterns(globalSkillsEntries);
  for (const p of globalPlain) {
    const resolved = resolvePath(p, agentDir, opts.homeDir);
    if (!existsSync(resolved)) continue;
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const found = collectSkillEntries(resolved, "pi", resolved);
      addEntries(found, resolved, "settings", "user");
    } else if (stat.isFile() && resolved.endsWith(".md")) {
      addEntries([resolved], resolved, "settings", "user");
    }
  }

  const piSkillsDir = join(agentDir, "skills");
  if (existsSync(piSkillsDir)) {
    const found = collectSkillEntries(piSkillsDir, "pi", piSkillsDir);
    addEntries(found, piSkillsDir, "auto", "user");
  }

  const agentsSkillsDir = join(opts.homeDir, ".agents", "skills");
  if (existsSync(agentsSkillsDir)) {
    const found = collectSkillEntries(agentsSkillsDir, "agents", agentsSkillsDir);
    addEntries(found, agentsSkillsDir, "auto", "user");
  }

  const projectPiSkillsDir = join(cwd, ".pi", "skills");
  if (existsSync(projectPiSkillsDir)) {
    const found = collectSkillEntries(projectPiSkillsDir, "pi", projectPiSkillsDir);
    addEntries(found, projectPiSkillsDir, "auto", "project");
  }

  const projectAgentsSkillsDir = join(cwd, ".agents", "skills");
  if (existsSync(projectAgentsSkillsDir)) {
    const found = collectSkillEntries(projectAgentsSkillsDir, "agents", projectAgentsSkillsDir);
    addEntries(found, projectAgentsSkillsDir, "auto", "project");
  }

  for (const ancestorDir of collectAncestorAgentsSkillDirs(cwd)) {
    if (existsSync(ancestorDir)) {
      const found = collectSkillEntries(ancestorDir, "agents", ancestorDir);
      addEntries(found, ancestorDir, "auto", "project");
    }
  }

  const { plain: projectPlain, patterns: projectPatterns } = splitPatterns(projectSkillsEntries);
  for (const p of projectPlain) {
    const resolved = resolvePath(p, cwd, opts.homeDir);
    if (!existsSync(resolved)) continue;
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const found = collectSkillEntries(resolved, "pi", resolved);
      addEntries(found, resolved, "settings", "project");
    } else if (stat.isFile() && resolved.endsWith(".md")) {
      addEntries([resolved], resolved, "settings", "project");
    }
  }

  const result: SkillInfo[] = [];
  for (const entry of allEntries) {
    const parsed = loadSkillFromFile(entry.filePath);
    if (!parsed) continue;
    const patterns = entry.scope === "project" ? projectPatterns : globalPatterns;
    const enabled = isEnabledByOverrides(entry.filePath, patterns, entry.sourcePath);
    let isSymlink = false;
    let realPath = entry.filePath;
    try {
      const stat = statSync(entry.filePath);
      isSymlink = stat.isSymbolicLink?.() ?? false;
      try { realPath = realpathSync(entry.filePath); } catch { /* keep default */ }
    } catch { /* keep default */ }
    result.push({
      name: parsed.name,
      description: parsed.description,
      filePath: entry.filePath,
      baseDir: dirname(entry.filePath),
      sourcePath: entry.sourcePath,
      sourceType: entry.sourceType,
      scope: entry.scope,
      enabled,
      disableModelInvocation: parsed.disableModelInvocation,
      isSymlink,
      realPath,
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function getSkillSourcePaths(agentDir: string, cwd: string): {
  user: string[];
  project: string[];
} {
  const globalSettingsPath = join(agentDir, "settings.json");
  const globalSettings = existsSync(globalSettingsPath)
    ? JSON.parse(readFileSync(globalSettingsPath, "utf-8")) as Record<string, unknown>
    : {};
  const globalSkills = (globalSettings.skills as string[]) ?? [];
  const userPlain = globalSkills.filter((s) => !isOverridePattern(s));

  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  const projectSettings = existsSync(projectSettingsPath)
    ? JSON.parse(readFileSync(projectSettingsPath, "utf-8")) as Record<string, unknown>
    : {};
  const projectSkills = (projectSettings.skills as string[]) ?? [];
  const projectPlain = projectSkills.filter((s) => !isOverridePattern(s));

  return { user: userPlain, project: projectPlain };
}
