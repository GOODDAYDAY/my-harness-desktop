/**
 * read-claude-md —— pi 内核 extension：会话启动自动发现全局与项目级 CLAUDE.md 指令文件并注入会话上下文。
 *
 * 发现规则（farthest-first，CSS cascade 序，后加载的更具体、优先级更高）：
 * - global：~/.claude/CLAUDE.md + ~/.claude/rules/ 下全部 .md（递归）
 * - project：cwd 逐级向上至文件系统根，每级读 CLAUDE.md、.claude/CLAUDE.md、.claude/rules/ 下全部 .md
 * - local：每级 CLAUDE.local.md
 * 按 resolved 路径去重，同一文件只加载一次。
 *
 * 注入策略：before_agent_start 时以隐藏会话消息（display:false，customType claude-md-context）
 * 注入，而非改 system prompt——system prompt 跨 turn 保持稳定，Anthropic prompt cache 可持续命中。
 * 每会话只注入一次（cwd 变化时刷新重注）。只注入主交互会话（ctx.hasUI）：sub-agent 不需要
 * CLAUDE.md，注入既浪费 token，其 cwd 差异还会破坏 prompt cache 稳定性。
 *
 * 类型不 import 官方 @earendil-works/pi-coding-agent（类型包在内核 node_modules，仓库 tsconfig
 * 够不到）——手写用到的窄结构，与 toolgate/llm-recorder 同纪律，保持本文件在仓库 typecheck 视野内。
 * 本文件由内核 piExtensionEnsure 随插件启停同步/摘除（~/.pi/agent/extensions/<pluginId>/），
 * 机制见 docs/design/llm-recorder-design.md §5。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 内核扩展 ctx 的窄镜像：只取注入用到的字段。 */
interface ClaudeMdContext {
  cwd: string;
  /** 是否有交互 UI（主会话 true，sub-agent false）。 */
  hasUI?: boolean;
  ui: { notify(message: string, level?: string): void };
}

/** 内核 ExtensionAPI 的窄镜像：只取本扩展挂的钩子与命令注册。 */
interface ClaudeMdApi {
  on(
    event: "session_start" | "before_agent_start",
    handler: (event: unknown, ctx: ClaudeMdContext) => unknown,
  ): void;
  registerCommand(
    name: string,
    def: { description: string; handler(args: unknown, ctx: ClaudeMdContext): unknown },
  ): void;
}

interface ClaudeFile {
  path: string;
  scope: "global" | "project" | "local";
  content: string;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    if (!fileExists(filePath)) return undefined;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Recursively find all .md files under a directory and return a sorted list of absolute paths */
function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

/** Collect all directories upward from startDir (including itself) to the filesystem root */
function collectDirsUpward(startDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function discoverClaudeFiles(cwd: string): ClaudeFile[] {
  const results: ClaudeFile[] = [];
  const seen = new Set<string>();

  function addFile(filePath: string, scope: ClaudeFile["scope"]) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    const content = readFileIfExists(resolved);
    if (content === undefined) return;
    seen.add(resolved);
    results.push({ path: resolved, scope, content });
  }

  function addDir(dir: string, scope: ClaudeFile["scope"]) {
    for (const f of findMarkdownFiles(dir)) {
      addFile(f, scope);
    }
  }

  // ── 1. Global scope ─────────────────────────────────────────────────────
  addFile(path.join(os.homedir(), ".claude", "CLAUDE.md"), "global");
  addDir(path.join(os.homedir(), ".claude", "rules"), "global");

  // ── 2. Project scope (farthest-first, CSS cascade style) ───────────────
  // Collect all directories from cwd upward to filesystem root, then reverse
  // → processes farthest ancestor first, down through git root, all the way to cwd
  const dirs = collectDirsUpward(cwd).reverse();

  for (const dir of dirs) {
    addFile(path.join(dir, "CLAUDE.md"), "project");
    addFile(path.join(dir, ".claude", "CLAUDE.md"), "project");
    addDir(path.join(dir, ".claude", "rules"), "project");
    addFile(path.join(dir, "CLAUDE.local.md"), "local");
  }

  return results;
}

function buildPromptSection(files: ClaudeFile[]): string {
  const fileList = files
    .map((file, index) => `${index + 1}. [${file.scope}] ${file.path}`)
    .join("\n");

  const fileContents = files
    .map(
      (file, index) =>
        `### ${index + 1}. ${file.path} (${file.scope})\n\n\`\`\`md\n${file.content.trim()}\n\`\`\``,
    )
    .join("\n\n");

  return `
## Loaded CLAUDE.md Instructions

The following CLAUDE.md instruction files were automatically loaded for this session.
Follow them as repository/user instructions. Files are ordered from most general (global) to
most specific (nearest project), so later entries take precedence over earlier ones.

Loaded files:
${fileList}

Contents:

${fileContents}
`;
}

export default function readClaudeMdExtension(pi: ClaudeMdApi) {
  let cachedCwd = "";
  let cachedFiles: ClaudeFile[] = [];
  let injected = false;

  function refresh(cwd: string) {
    cachedCwd = cwd;
    cachedFiles = discoverClaudeFiles(cwd);
    injected = false;
  }

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx.cwd);
    if (cachedFiles.length > 0) {
      ctx.ui.notify(`Loaded ${cachedFiles.length} CLAUDE.md file(s)`, "info");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Only inject for the main interactive session.
    // Sub-agents don't need CLAUDE.md; injecting there wastes tokens and breaks prompt cache
    // stability (sub-agents may have different cwds, causing different system prompts each call).
    if (!ctx.hasUI) return;
    if (ctx.cwd !== cachedCwd) {
      refresh(ctx.cwd);
    }
    if (cachedFiles.length === 0) return;
    // Inject once per session (or once per cwd change) as a conversation message,
    // not as a system prompt modification. This keeps the system prompt stable across
    // turns so Anthropic's prompt cache can work effectively.
    if (injected) return;
    injected = true;
    return {
      message: {
        customType: "claude-md-context",
        content: buildPromptSection(cachedFiles),
        display: false,
      },
    };
  });

  pi.registerCommand("claude-md", {
    description: "Show discovered CLAUDE.md files currently loaded by the extension",
    async handler(_args, ctx) {
      if (ctx.cwd !== cachedCwd) {
        refresh(ctx.cwd);
      }
      if (cachedFiles.length === 0) {
        ctx.ui.notify(`No CLAUDE.md files found.\nCWD: ${ctx.cwd}`, "info");
        return;
      }
      const lines = [
        "📘 Loaded CLAUDE.md files:",
        `CWD: ${ctx.cwd}`,
        ...cachedFiles.map((file, index) => `  ${index + 1}. [${file.scope}] ${file.path}`),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
