// 种子解释引擎 —— common 的机制面:读场景 bundle 的数据文件,写隔离 HOME。
//
// 场景 = 独立个体(bundle 目录):
//   index.mjs    steps(纯行为,文案走 $t key,语言无关)
//   seed.json    声明式种子(prefs/configs/projects/sessions/skills/llmLogs)
//   locales/     本场景文案字典(zh-CN.json / en.json,可选)
//   sessions/    本场景独有会话 rows(可选;共享会话引用 common presets)
// common presets = 共享素材(同样数据化):projects 文件树 / sessions rows /
// skills / configs / locales 字典。场景在 seed.json 里按名引用,覆盖语义:
// 场景 locales 覆盖 common locales(与插件语言槽同款)。
//
// 两种引用,两轮解析:
//   {"$t":"key"}   文案引用——按录制 locale 查合并后的字典(缺失即抛错)
//   "{todo}"/"{home}" 路径 token——fixture 项目在隔离区内的动态路径,applySeed 时解析
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { writeSessionFile, sessionLogTexts } from "./session-writer.mjs";

const HERE = import.meta.dirname;
const PRESETS = join(HERE, "presets");

/** 读 JSON(缺失返回 fallback)。 */
function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** 深度解析 {"$t":"key"}:字典查值,缺失抛错(演示文案必须齐全,静默降级会录出坏 GIF)。 */
function resolveI18n(value, dict) {
  if (Array.isArray(value)) return value.map((v) => resolveI18n(v, dict));
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$t") {
      const hit = dict[value.$t];
      if (typeof hit !== "string") throw new Error(`i18n key 缺失: ${value.$t}`);
      return hit;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveI18n(v, dict)]));
  }
  return value;
}

/** 深度替换动态值:
 *  {"$now":偏移ms} → 录制时刻时间戳(createdAt 等需要"现在"的字段);
 *  "{name}" 整串 → 路径;内嵌 "{name}" → 字符串插值(fixture 路径是隔离区动态值)。 */
function resolveTokens(value, tokens) {
  if (Array.isArray(value)) return value.map((v) => resolveTokens(v, tokens));
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$now") return Date.now() + (Number(value.$now) || 0);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTokens(v, tokens)]));
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{([a-zA-Z0-9-]+)\}$/);
  if (exact) {
    if (!(exact[1] in tokens)) throw new Error(`路径 token 未定义: ${value}`);
    return tokens[exact[1]];
  }
  return value.replace(/\{([a-zA-Z0-9-]+)\}/g, (m, name) => {
    if (!(name in tokens)) throw new Error(`路径 token 未定义: ${m}`);
    return tokens[name];
  });
}

/** 载入场景 bundle:steps + seed spec,全部完成 $t 解析(按录制 locale)。
 *  字典 = common presets locales ← 场景 locales(场景覆盖 common)。
 *  dict 随结果返回:会话 rows 文件在 applySeed 时才读取,需同一份字典解析。 */
export async function loadScenario(scenarioDir, locale) {
  const mod = await import(pathToFileURL(join(scenarioDir, "index.mjs")).href);
  const dict = {
    ...readJson(join(PRESETS, "locales", `${locale}.json`), {}),
    ...readJson(join(scenarioDir, "locales", `${locale}.json`), {}),
  };
  const spec = resolveI18n(readJson(join(scenarioDir, "seed.json"), {}), dict);
  const steps = resolveI18n(mod.default.steps, dict);
  return { name: mod.default.name, spec, steps, dict };
}

/** 把解析后的 seed spec 写入隔离 HOME(经 ctx,不自己拼数据根外的路径)。 */
export function applySeed(ctx, scenarioDir, spec, dict) {
  // ── fixture 项目:presets 文件树整拷(目录名映射见 presets/projects.json)──
  const projectManifest = readJson(join(PRESETS, "projects.json"), {});
  const paths = { home: ctx.home };
  for (const name of spec.projects ?? []) {
    const dir = projectManifest[name]?.dir;
    if (!dir) throw new Error(`未知 fixture 项目 preset: ${name}`);
    const target = join(ctx.home, dir);
    cpSync(join(PRESETS, "projects", name), target, { recursive: true });
    paths[name] = target;
  }
  const resolved = resolveTokens(spec, paths);

  // ── 会话:preset 引用 common rows,文件引用场景自带 rows(rows 读取时做 $t 解析)──
  const loadRows = (s) => {
    const src = s.preset
      ? join(PRESETS, "sessions", `${s.preset}.json`)
      : join(scenarioDir, s.file);
    const doc = readJson(src);
    if (!doc) throw new Error(`会话种子缺失: ${s.preset ?? s.file}`);
    return resolveI18n(doc, dict);
  };
  const sessionDocs = (resolved.sessions ?? []).map(loadRows);
  const sessionPaths = sessionDocs.map((doc, i) => {
    const cwd = paths[resolved.sessions[i].project];
    if (!cwd) throw new Error(`会话引用了未种的项目: ${resolved.sessions[i].project}`);
    return writeSessionFile(ctx.agentDir, cwd, doc.rows, doc.ageHours ?? 0);
  });

  // ── llm-logs:从引用会话的 rows 派生 request/response 配对(格式见 llm-recorder-design §3.2)──
  if (resolved.llmLogs) {
    const idx = resolved.llmLogs.session ?? 0;
    const { user, done } = sessionLogTexts(sessionDocs[idx]?.rows ?? []);
    const base = Date.now() - 24 * 3600_000;
    const lines = [
      { seq: 1, ts: base, kind: "request", turnIndex: 0, payload: { model: "model-1.1", messages: [{ role: "user", content: user }] } },
      { seq: 1, ts: base + 2100, kind: "response", status: 200, durationMs: 2100, message: { role: "assistant", content: done } },
    ];
    const fileName = sessionPaths[idx].split(/[\\/]/).pop();
    const logsDir = join(paths[resolved.sessions[idx].project], ".pi-desktop", "llm-logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, fileName), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  }

  // ── 技能:presets/skills.json 的 name→描述($t 引用),写 SKILL.md ──
  if (resolved.skills?.length) {
    const catalog = readJson(join(PRESETS, "skills.json"), {});
    for (const name of resolved.skills) {
      const desc = resolveI18n(catalog[name], dict);
      if (typeof desc !== "string") throw new Error(`未知技能 preset: ${name}`);
      const dir = join(ctx.agentDir, "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${desc}.\n`);
    }
  }

  // ── 配置:共享 config preset 整份($t 解析) + 场景 configs 逐份;项目级配置落 <cwd>/.pi-desktop/config/ ──
  for (const name of resolved.configPresets ?? []) {
    const doc = readJson(join(PRESETS, "configs", `${name}.json`));
    if (!doc) throw new Error(`未知 config preset: ${name}`);
    ctx.writeConfig(name, resolveI18n(doc, dict));
  }
  for (const [name, doc] of Object.entries(resolved.configs ?? {})) ctx.writeConfig(name, doc);
  for (const [project, configs] of Object.entries(resolved.projectConfigs ?? {})) {
    for (const [name, doc] of Object.entries(configs)) ctx.writeProjectConfig(paths[project], name, doc);
  }

  // ── prefs / general:浅合并覆盖基线默认 ──
  if (resolved.general) ctx.setGeneral(resolved.general);
  if (resolved.prefs) ctx.setPrefs(resolved.prefs);
}

/** parallel-record 自动发现用的场景目录列表。 */
export function listScenarios(scenariosDir) {
  return readdirSync(scenariosDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(scenariosDir, d.name, "index.mjs")))
    .map((d) => d.name)
    .sort();
}
