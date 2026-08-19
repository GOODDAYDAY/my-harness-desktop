// pi 扩展的扫描逻辑 —— 跑在 pi 进程里,读 pi 自己的存储(settings.json + skills 目录),
// 算完整列表(含禁用),产出中性 SkillInfo。这是"内核负责读"的 pi 侧实现。
// 与旧壳扫描器的差异:这里读的是 pi 自己的存储(合法),产出的是中性 SkillInfo(不带内核细节)。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

interface NeutralSkill {
  name: string;
  description: string;
  scope: "user" | "project";
  enabled: boolean;
  modelInvocable: boolean;
  userInvocable: boolean;
  source: string;
  filePath: string;
}

function readSettingsJson(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  try {
    const parsed = parseYaml(normalized.slice(4, endIndex)) ?? {};
    return { frontmatter: parsed as Record<string, unknown>, body: normalized.slice(endIndex + 4).trim() };
  } catch {
    return { frontmatter: {}, body: normalized };
  }
}

function loadSkill(filePath: string): { name: string; description: string; disableModelInvocation: boolean } | null {
  try {
    const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const name = (frontmatter.name as string) || basename(dirname(filePath));
    const description = (frontmatter.description as string) ?? "";
    if (!description.trim()) return null;
    return { name, description, disableModelInvocation: frontmatter["disable-model-invocation"] === true };
  } catch {
    return null;
  }
}

/** 递归找 SKILL.md(目录 bundle)或根级裸 .md,跳过 . 开头和 node_modules。 */
function collectSkillFiles(dir: string, root: string): string[] {
  const entries: string[] = [];
  if (!existsSync(dir)) return entries;
  try {
    const dirents = readdirSync(dir, { withFileTypes: true });
    for (const e of dirents) {
      if (e.name === "SKILL.md") {
        const p = join(dir, e.name);
        let isFile = e.isFile();
        if (e.isSymbolicLink()) { try { isFile = statSync(p).isFile(); } catch { continue; } }
        if (isFile) { entries.push(p); return entries; }
      }
    }
    for (const e of dirents) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try { const s = statSync(p); isDir = s.isDirectory(); isFile = s.isFile(); } catch { continue; }
      }
      if (dir === root && isFile && e.name.endsWith(".md") && !/^readme/i.test(e.name)) { entries.push(p); continue; }
      if (!isDir) continue;
      entries.push(...collectSkillFiles(p, root));
    }
  } catch { /* ignore */ }
  return entries;
}

function isOverridePattern(s: string): boolean {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

function stripPrefix(s: string): string {
  return isOverridePattern(s) ? s.slice(1) : s;
}

function resolvePath(input: string, base: string): string {
  let p = input.trim();
  if (p.startsWith("~")) p = join(homedir(), p.slice(1));
  return p.startsWith("/") ? resolve(p) : resolve(base, p);
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function matchesAny(rel: string, abs: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.includes("*") || p.includes("?")) {
      const regex = p.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".");
      return new RegExp(`^${regex}$`).test(rel) || new RegExp(`^${regex}$`).test(abs);
    }
    return rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`)
      || abs === p || abs.startsWith(p.endsWith("/") ? p : `${p}/`);
  });
}

function matchesExact(rel: string, abs: string, patterns: string[]): boolean {
  return patterns.some((p) => rel === p || abs === p);
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
  const overrides = patterns.filter(isOverridePattern);
  const excludes = overrides.filter((p) => p.startsWith("!")).map(stripPrefix);
  const forceIncludes = overrides.filter((p) => p.startsWith("+")).map(stripPrefix);
  const forceExcludes = overrides.filter((p) => p.startsWith("-")).map(stripPrefix);
  const rel = toPosix(relative(baseDir, filePath));
  const abs = toPosix(filePath);
  let enabled = true;
  if (excludes.length && matchesAny(rel, abs, excludes)) enabled = false;
  if (forceIncludes.length && matchesExact(rel, abs, forceIncludes)) enabled = true;
  if (forceExcludes.length && matchesExact(rel, abs, forceExcludes)) enabled = false;
  return enabled;
}

function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function ancestorAgentsDirs(start: string): string[] {
  const dirs: string[] = [];
  const gitRoot = findGitRoot(start);
  let dir = resolve(start);
  while (true) {
    dirs.push(join(dir, ".agents", "skills"));
    if (gitRoot && dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** 扫 pi 的全部技能来源,产出中性 SkillInfo[](含禁用)。cwd 是 pi 进程的工作目录。 */
export function scanPiSkills(cwd: string): NeutralSkill[] {
  const agentDir = join(homedir(), ".pi", "agent");
  const globalEntries = (readSettingsJson(join(agentDir, "settings.json")).skills as string[]) ?? [];
  const projectEntries = (readSettingsJson(join(cwd, ".pi", "settings.json")).skills as string[]) ?? [];
  const globalPlain = globalEntries.filter((s) => !isOverridePattern(s));
  const globalPatterns = globalEntries.filter(isOverridePattern);
  const projectPlain = projectEntries.filter((s) => !isOverridePattern(s));
  const projectPatterns = projectEntries.filter(isOverridePattern);

  interface Entry { filePath: string; sourcePath: string; scope: "user" | "project"; source: string }
  const all: Entry[] = [];
  const seen = new Set<string>();
  const add = (files: string[], sourcePath: string, scope: "user" | "project", source: string) => {
    for (const fp of files) {
      if (seen.has(fp)) continue;
      seen.add(fp);
      all.push({ filePath: fp, sourcePath, scope, source });
    }
  };

  for (const p of globalPlain) {
    const resolved = resolvePath(p, agentDir);
    if (!existsSync(resolved)) continue;
    const s = statSync(resolved);
    if (s.isDirectory()) add(collectSkillFiles(resolved, resolved), resolved, "user", "local");
    else if (s.isFile() && resolved.endsWith(".md")) add([resolved], dirname(resolved), "user", "local");
  }
  add(collectSkillFiles(join(agentDir, "skills"), join(agentDir, "skills")), join(agentDir, "skills"), "user", "auto");
  add(collectSkillFiles(join(homedir(), ".agents", "skills"), join(homedir(), ".agents", "skills")), join(homedir(), ".agents", "skills"), "user", "auto");
  add(collectSkillFiles(join(cwd, ".pi", "skills"), join(cwd, ".pi", "skills")), join(cwd, ".pi", "skills"), "project", "auto");
  add(collectSkillFiles(join(cwd, ".agents", "skills"), join(cwd, ".agents", "skills")), join(cwd, ".agents", "skills"), "project", "auto");
  for (const d of ancestorAgentsDirs(cwd)) {
    add(collectSkillFiles(d, d), d, "project", "auto");
  }
  for (const p of projectPlain) {
    const resolved = resolvePath(p, cwd);
    if (!existsSync(resolved)) continue;
    const s = statSync(resolved);
    if (s.isDirectory()) add(collectSkillFiles(resolved, resolved), resolved, "project", "local");
    else if (s.isFile() && resolved.endsWith(".md")) add([resolved], dirname(resolved), "project", "local");
  }

  const result: NeutralSkill[] = [];
  for (const entry of all) {
    const parsed = loadSkill(entry.filePath);
    if (!parsed) continue;
    const patterns = entry.scope === "project" ? projectPatterns : globalPatterns;
    result.push({
      name: parsed.name,
      description: parsed.description,
      scope: entry.scope,
      enabled: isEnabledByOverrides(entry.filePath, patterns, entry.sourcePath),
      modelInvocable: !parsed.disableModelInvocation,
      userInvocable: true,
      source: entry.source,
      filePath: entry.filePath,
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
