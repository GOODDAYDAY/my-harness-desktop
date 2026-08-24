/**
 * skill-manager 的 dsh 内核插件 —— fork dsh-skill-filesystem 补「启用/禁用」轴 + 完整列表播报。
 *
 * 依据 docs/design/skills-layering.md §4.2/§4.4:dsh 的 SkillRegistry 只有「往里加」没有
 * 「往外删」,要「关闭」某技能必须在发现阶段过滤。本插件 fork 一份带 disabled 名单过滤的
 * 发现 provider 替换 skill-filesystem(不动 dsh 核心),并把完整列表(含禁用、带 enabled 标志)
 * 写播报文件,壳侧 dsh-skill-provider 读它。
 *
 * 与 read-claude-md/goal/ask 的 dsh-extension 不同:本插件 import dsh 内核包
 * (@deepseek-ai/dsh-skill-filesystem)来复用其发现逻辑——这是「关闭」轴唯一的可靠落法
 * (SkillRegistry 无第三方 hook,包裹/替换是必经之路),是刻意打破「零 import dsh 包」的一处。
 *
 * 数据流:
 *   disabled 名单  ~/.dsh/.my-harness-desktop-disabled-skills.json   (壳写,本插件读)
 *   播报文件        ~/.dsh/desktop-skills.json                        (本插件写,壳读)
 *   给 registry 的 provider.list() 返回「全部 - disabled」(模型只看得到 enabled)
 *   播报写「全部含 disabled 标记」(管理页要双向开关,禁用项必须可见可重新启用)
 */
import { homedir } from "node:os";
import { readFileSync, writeFileSync, watchFile, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";

export const name = "desktop-skill";
export const inject = ["skills"];

const DISABLED_FILE = join(homedir(), ".dsh", ".my-harness-desktop-disabled-skills.json");
const BROADCAST_FILE = join(homedir(), ".dsh", "desktop-skills.json");

/** 读 disabled 名单(技能名集合);文件缺失/损坏回空集合,不炸 dsh。 */
function readDisabled() {
  try {
    const raw = JSON.parse(readFileSync(DISABLED_FILE, "utf8"));
    return new Set(Array.isArray(raw?.skills) ? raw.skills : []);
  } catch {
    return new Set();
  }
}

/** dsh 的 SkillSource 枚举 → 壳的 scope(user/project)。带 project- 前缀的根归项目,其余全局。 */
function scopeOf(source) {
  return typeof source === "string" && source.startsWith("project") ? "project" : "user";
}

/** 一条 candidate 翻译成中性 SkillInfo(形状与 packages/skills-extension/scanner.ts 产出对齐)。 */
function toSkillInfo(candidate, disabled) {
  return {
    name: candidate.name,
    description: candidate.description ?? "",
    scope: scopeOf(candidate.source),
    enabled: !disabled.has(candidate.name),
    modelInvocable: candidate.invocation?.modelInvocable ?? true,
    source: candidate.source,
    // dsh 的 candidate 无「扫描根目录」字段,用 source 枚举(user-dsh/user-agents/custom/...)
    // 作为分组键——壳只把它当字符串分组/显示,不要求是真实路径。
    sourceDir: candidate.source,
    filePath: candidate.path,
  };
}

function writeBroadcast(skills) {
  try {
    mkdirSync(dirname(BROADCAST_FILE), { recursive: true });
    writeFileSync(BROADCAST_FILE, JSON.stringify(skills, null, 2), "utf8");
  } catch (err) {
    // 写失败不炸 dsh:壳读不到播报文件时降级空列表。
    console.error("[desktop-skill] broadcast failed:", err?.message ?? String(err));
  }
}

export function apply(ctx, config = {}) {
  let inner;
  let controlRef;

  // 路径注入(演进):壳路径表动态写 customSkillDirs 是设计文档 §7.3 的第三步、尚未落地,
  // 这里默认并入 Claude Code 固定目录(~/.claude/skills,与 pi 侧用户配置的同一目录),
  // cordis.yml config.customSkillDirs 可继续追加。去重保证不重复扫。
  const claudeSkills = join(homedir(), ".claude", "skills");
  const customSkillDirs = [...new Set([...(config.customSkillDirs ?? []), claudeSkills])];
  const effectiveConfig = { ...config, customSkillDirs };

  // 1. 注册过滤 provider:给 registry 的 list() 只回「全部 - disabled」,被禁用的不进 catalog,
  //    模型和用户 slash 菜单都看不到(真「关闭」)。发现逻辑复用 FileSystemSkillProvider。
  const disposeProvider = ctx.skills.registerProvider((control) => {
    controlRef = control;
    inner = new FileSystemSkillProvider(ctx, control, effectiveConfig);
    return {
      name: inner.name,
      async list(options) {
        const obs = await inner.list(options);
        const candidates = Array.isArray(obs) ? obs : obs.candidates;
        const disabled = readDisabled();
        return candidates.filter((c) => !disabled.has(c.name));
      },
      async get(candidate, options) {
        return inner.get(candidate, options);
      },
    };
  });

  // 2. 播报完整列表(含禁用)。inner.list() 返回全部候选(同名不同源不合并),disabled 名单标 enabled。
  const broadcast = async (cwd) => {
    if (!inner) return;
    try {
      const obs = await inner.list({ cwd });
      const candidates = Array.isArray(obs) ? obs : obs.candidates;
      const disabled = readDisabled();
      writeBroadcast(candidates.map((c) => toSkillInfo(c, disabled)));
    } catch (err) {
      console.error("[desktop-skill] broadcast error:", err?.message ?? String(err));
    }
  };

  // skills/change 是 dsh-skill 的目录失效通知(provider/catalog 变化),重写播报。
  ctx.on("skills/change", () => { void broadcast(process.cwd()); });

  // disabled 名单变化 → 让 registry 缓存失效(重过滤)。invalidate 会 emit skills/change,
  // 上面 ctx.on("skills/change") 负责重写播报(新的 enabled 标记),这里不重复 broadcast。
  const watcher = watchFile(DISABLED_FILE, () => {
    try { controlRef?.invalidate(); } catch { /* ignore */ }
  });

  // 首次播报:进程启动即有数据,壳无需等 session_start。
  void broadcast(process.cwd());

  // 生命周期:插件卸载时停止监听 disabled 名单 + unregister provider。
  ctx.effect(function* () {
    yield () => {
      try { watcher.close(); } catch { /* ignore */ }
      try { disposeProvider(); } catch { /* ignore */ }
    };
  }, "desktop-skill");
}
