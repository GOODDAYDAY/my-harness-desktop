/**
 * read-claude-md 的 dsh 内核插件 —— 会话 pre-step 自动发现全局 CLAUDE.md 指令文件并注入会话上下文。
 *
 * 对称 pi 侧 pi-extension/extension/index.ts：pi 挂 before_agent_start / session_start，dsh 挂 agent/pre-step。
 * 只做全局（~/.claude/CLAUDE.md + ~/.claude/rules/ 下全部 .md，递归）；project 级由 dsh 自带的
 * agent-instructions 负责（它已从 projectRoot 到 cwd 逐级读 AGENTS.md/CLAUDE.md），两边不重叠。
 *
 * 注入姿势照抄 dsh 的 agent-instructions（packages/context/agent-instructions/src/index.ts）：
 * source.kind='agent-instructions' 的 user 消息折进 step messages，幂等（本轮已含相同 context 不重复折入），
 * 不改 system prompt，保住 prompt cache。
 *
 * 零 import dsh 内核包（手写窄形状，与 pi-extension 同纪律），只用 node 内建模块。
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const name = "claude-context";

// ---- 文件发现（对齐 pi-extension 的 discoverClaudeFiles 全局部分）----

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readIfExists(p) {
  try {
    return isFile(p) ? readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** 递归收集 dir 下全部 .md（按文件名字典序，稳定）。目录不存在返回 []。 */
function findMarkdownFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...findMarkdownFiles(full));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** 发现全局 CLAUDE.md 指令文件：~/.claude/CLAUDE.md + ~/.claude/rules/ 下全部 .md（递归，按路径去重）。 */
function discoverGlobalClaudeFiles() {
  const files = [];
  const seen = new Set();
  const add = (p, scope) => {
    const r = resolve(p);
    if (seen.has(r)) return;
    const content = readIfExists(r);
    if (content === undefined) return;
    seen.add(r);
    files.push({ path: r, scope, content });
  };
  add(join(homedir(), ".claude", "CLAUDE.md"), "global");
  for (const f of findMarkdownFiles(join(homedir(), ".claude", "rules"))) add(f, "global");
  return files;
}

function buildPromptSection(files) {
  const fileList = files.map((f, i) => `${i + 1}. [${f.scope}] ${f.path}`).join("\n");
  const contents = files
    .map((f, i) => `### ${i + 1}. ${f.path} (${f.scope})\n\n\`\`\`md\n${f.content.trim()}\n\`\`\``)
    .join("\n\n");
  return `\n## Loaded CLAUDE.md Instructions\n\nThe following CLAUDE.md instruction files were automatically loaded for this session.\nFollow them as repository/user instructions. Files are ordered from most general (global) to most specific.\n\nLoaded files:\n${fileList}\n\nContents:\n\n${contents}\n`;
}

/** 幂等判据：role + content + source 逐字段相等（对齐 agent-instructions 的 sameContextPayload）。 */
function sameContext(a, b) {
  return a.role === b.role
    && JSON.stringify(a.content) === JSON.stringify(b.content)
    && JSON.stringify(a.source) === JSON.stringify(b.source);
}

// ---- 插件 ----

export function apply(ctx) {
  // 全局指令文件缓存：进程生命周期内读一次。文件变化需重启 dsh 内核才生效——演进项，
  // 与 project 级的 fs-watch 刷新（agent-instructions 经 tools/result 触发）不在同一层。
  let cached;

  ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;

    if (cached === undefined) cached = discoverGlobalClaudeFiles();
    if (cached.length === 0) return decision;

    const desired = {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: buildPromptSection(cached) }],
      source: { kind: "agent-instructions", form: "instructions", baseline: true },
    };

    // 幂等：本轮 step 已含相同 context 就不重复折入。
    if (decision.messages.some((m) => sameContext(m, desired))) return decision;

    // 折到 claimed 批次之后（照抄 agent-instructions 的注入位置）。
    const lastClaimedIndex = decision.messages.findLastIndex((m) => messages.includes(m));
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
    return { kind: "enter", messages: entered };
  });
}
