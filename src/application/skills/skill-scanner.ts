import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import ignore, { type Ignore } from "ignore";
import { parse as parseYaml } from "yaml";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

function addIgnoreRules(ig: Ignore, dir: string, rootDir: string): void {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) continue;
    try {
      const content = readFileSync(ignorePath, "utf-8");
      const patterns: string[] = [];
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) continue;
        let pattern = line;
        let negated = false;
        if (pattern.startsWith("!")) { negated = true; pattern = pattern.slice(1); }
        else if (pattern.startsWith("\\!")) { pattern = pattern.slice(1); }
        if (pattern.startsWith("/")) pattern = pattern.slice(1);
        const prefixed = prefix ? `${prefix}${pattern}` : pattern;
        patterns.push(negated ? `!${prefixed}` : prefixed);
      }
      if (patterns.length > 0) ig.add(patterns);
    } catch { /* ignore read errors */ }
  }
}

interface ParsedSkill {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
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
  ig: Ignore,
  root: string,
): string[] {
  const entries: string[] = [];
  if (!existsSync(dir)) return entries;
  addIgnoreRules(ig, dir, root);
  try {
    const dirEntries = readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name !== "SKILL.md") continue;
      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { isFile = statSync(fullPath).isFile(); } catch { continue; }
      }
      const relPath = toPosixPath(relative(root, fullPath));
      if (isFile && !ig.ignores(relPath)) {
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
      const relPath = toPosixPath(relative(root, fullPath));
      if (mode === "pi" && dir === root && isFile && entry.name.endsWith(".md") && !ig.ignores(relPath)) {
        entries.push(fullPath);
        continue;
      }
      if (!isDir) continue;
      if (ig.ignores(`${relPath}/`)) continue;
      entries.push(...collectSkillEntries(fullPath, mode, ig, root));
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

function isOverridePattern(s: string): boolean {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
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

function resolvePath(input: string, baseDir: string): string {
  let p = input.trim();
  if (p.startsWith("~")) p = join(homedir(), p.slice(1));
  if (p.startsWith("/")) return resolve(p);
  return resolve(baseDir, p);
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

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourcePath: string;
  sourceType: "settings" | "auto";
  scope: "user" | "project";
  enabled: boolean;
  disableModelInvocation: boolean;
  isSymlink: boolean;
  realPath: string;
}

export interface ScanOptions {
  agentDir: string;
  cwd: string;
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
    const resolved = resolvePath(p, agentDir);
    if (!existsSync(resolved)) continue;
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const ig = ignore();
      const found = collectSkillEntries(resolved, "pi", ig, resolved);
      addEntries(found, resolved, "settings", "user");
    } else if (stat.isFile() && resolved.endsWith(".md")) {
      addEntries([resolved], resolved, "settings", "user");
    }
  }

  const piSkillsDir = join(agentDir, "skills");
  if (existsSync(piSkillsDir)) {
    const ig = ignore();
    const found = collectSkillEntries(piSkillsDir, "pi", ig, piSkillsDir);
    addEntries(found, piSkillsDir, "auto", "user");
  }

  const agentsSkillsDir = join(homedir(), ".agents", "skills");
  if (existsSync(agentsSkillsDir)) {
    const ig = ignore();
    const found = collectSkillEntries(agentsSkillsDir, "agents", ig, agentsSkillsDir);
    addEntries(found, agentsSkillsDir, "auto", "user");
  }

  const projectPiSkillsDir = join(cwd, ".pi", "skills");
  if (existsSync(projectPiSkillsDir)) {
    const ig = ignore();
    const found = collectSkillEntries(projectPiSkillsDir, "pi", ig, projectPiSkillsDir);
    addEntries(found, projectPiSkillsDir, "auto", "project");
  }

  const projectAgentsSkillsDir = join(cwd, ".agents", "skills");
  if (existsSync(projectAgentsSkillsDir)) {
    const ig = ignore();
    const found = collectSkillEntries(projectAgentsSkillsDir, "agents", ig, projectAgentsSkillsDir);
    addEntries(found, projectAgentsSkillsDir, "auto", "project");
  }

  for (const ancestorDir of collectAncestorAgentsSkillDirs(cwd)) {
    if (existsSync(ancestorDir)) {
      const ig = ignore();
      const found = collectSkillEntries(ancestorDir, "agents", ig, ancestorDir);
      addEntries(found, ancestorDir, "auto", "project");
    }
  }

  const { plain: projectPlain, patterns: projectPatterns } = splitPatterns(projectSkillsEntries);
  for (const p of projectPlain) {
    const resolved = resolvePath(p, cwd);
    if (!existsSync(resolved)) continue;
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const ig = ignore();
      const found = collectSkillEntries(resolved, "pi", ig, resolved);
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
