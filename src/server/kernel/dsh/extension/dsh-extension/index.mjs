/**
 * my-harness-fit-dsh-extension —— 桌面壳对 dsh 内核的统一 cordis 适配插件。
 *
 * 合并自原先随 4 个桌面插件携带的 dsh cordis 插件(ask / goal / read-claude-md / skill-manager),
 * 收敛为一处 bootstrap 常驻同步(不再随桌面插件启停)。四块能力:
 *   1. ask_user_question 工具 —— 文件侧车桥,同轮回填(原 desktop-ask)
 *   2. get_goal / create_goal / update_goal 三工具 —— 文件侧车持久化 + CAS(原 desktop-goal)
 *   3. agent/pre-step 全局 CLAUDE.md 注入(原 claude-context)
 *   4. skill-filesystem 启用/禁用轴 + 完整列表播报(原 desktop-skill)
 *
 * 除 skill 轴需 import @deepseek-ai/dsh-skill-filesystem(「关闭」轴唯一可靠落法)外,
 * 其余零 import dsh 内核包,只用 node 内建模块。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import { HarnessSdkJsonRpcServer } from "@deepseek-ai/dsh-sdk-jsonrpc-server";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";

export const name = "my-harness-fit-dsh-extension";

// cordis 服务依赖声明:apply 里访问 ctx.tools / ctx.skills 必须先在此注入(否则插件树加载期抛
// "cannot get property ... without inject" → 整个 dsh 内核崩溃)。对齐 dsh-schedule 的 inject 纪律。
export const inject = ["tools", "skills"];

// ==============================================================================================
// 6. session/meta 事件类型补面 —— dsh 的 session/rename(session/updateHeader)会写 session/meta
//    事件,但 deepseek-harness 源码的 KNOWN_SESSION_EVENT_TYPES(known-event-types.ts)漏收了
//    该类型 → resume 重放时 coordinator.assertEventsSupported 抛「session/meta unknown」,
//    重开续聊崩。这是 dsh 侧遗漏(壳不能改其源码),按用户方案在桌面适配插件里补面:
//    运行时把 "session/meta" 加进已知事件类型集(该集合是普通 Set,运行时可 add;插件与
//    coordinator 共享同一模块实例,补了即对 resume 校验生效)。内核发版补上后此段可删。
// ==============================================================================================

// 幂等补面:已收录则跳过(内核发版修复后不再重复 add)。
if (!KNOWN_SESSION_EVENT_TYPES.has("session/meta")) {
  (KNOWN_SESSION_EVENT_TYPES as Set<string>).add("session/meta");
}

// ==============================================================================================
// 5. session/setModel 补面 —— 旧 dsh(0.1.1-rc.2)的 sdk-jsonrpc-server 只有 3 个 request 方法,
//    缺 session/setModel(运行时切模型,模型停在 initialize 握手值)。deepseek-harness 源码已补
//    (commit 5d70fb1883),但 npm 未发版。这里在进程启动加载本插件时给 server 原型打补丁:
//    拦截 session/setModel 走 dispose+flush+resume 热切,与 server 实现同款。内核发版追上
//    (prototype 上出现 setModel 方法)即自动跳过,届时此段删除(与 pi patch-rpc-mode 同款临时桥)。
//    纯代码补面,随 cordis.yml 动态装载,不预编译、不落中间产物。
// ==============================================================================================

if (typeof HarnessSdkJsonRpcServer.prototype.setModel !== "function") {
  const __dshServerHandleRequest = HarnessSdkJsonRpcServer.prototype.handleRequest;
  HarnessSdkJsonRpcServer.prototype.handleRequest = async function (method, params) {
    if (method === "session/setModel") {
      const record = this.sessions.get(params.sessionId);
      if (!record) throw new Error(`unknown session: ${params.sessionId}`);
      const sessionId = record.handle.agent.id;
      await this.ctx.sessions.flush(record.handle.agent.session);
      await record.handle.dispose();
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: params.provider, model: params.modelId },
      });
      this.sessions.set(params.sessionId, { handle });
      return {};
    }
    return __dshServerHandleRequest.call(this, method, params);
  };
}

// ==============================================================================================
// 1. ask —— ask_user_question 工具(文件侧车桥,同轮回填)
//    设计 docs/design/goal-ask-pi-port.md §5 + 文件侧车桥方案。不改 deepseek-harness:
//    不依赖 ctx.userQuestions(它需要 SDK server 补 answer 通道)。改为进程内阻塞 + 文件侧车:
//    execute 写 ~/.pi/agent/.my-harness-desktop-questions/<id>.json → 轮询 <id>.answer.json
//    直到桌面壳写入答案(execute 阻塞 = 同轮暂停)→ 读到答案 resolve,回灌模型(同轮继续)。
// ==============================================================================================

const QUESTIONS_DIR = join(homedir(), ".pi", "agent", ".my-harness-desktop-questions");
const ASK_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 200;

const questionPath = (id) => join(QUESTIONS_DIR, `${id}.json`);
const answerPath = (id) => join(QUESTIONS_DIR, `${id}.answer.json`);

/** 轮询答案文件直到出现或超时;返回 { answers } 或 { cancelled: true }。 */
async function waitForAnswer(id, signal) {
  const deadline = Date.now() + ASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { cancelled: true };
    try {
      const parsed = JSON.parse(readFileSync(answerPath(id), "utf8"));
      rmSync(answerPath(id), { force: true });
      rmSync(questionPath(id), { force: true });
      return parsed;
    } catch {
      await new Promise((r) => globalThis.setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  rmSync(questionPath(id), { force: true });
  return { cancelled: true };
}

const ASK_DESCRIPTION =
  "Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. "
  + "Send one or more questions, each with a stable id that will be echoed in the answer.";

// ==============================================================================================
// 2. goal —— get_goal / create_goal / update_goal 三工具(文件侧车持久化 + CAS)
//    设计 docs/design/goal-ask-pi-port.md §6。每会话一个 goal 快照,落
//    ~/.pi/agent/.my-harness-desktop-goals/<sessionId>.json,CAS 靠 {id, revision} 校验。
//    activation 位进程本地(重启即 disarmed,对齐 DSH 语义)。
// ==============================================================================================

const GOALS_DIR = join(homedir(), ".pi", "agent", ".my-harness-desktop-goals");
const BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3;

const goalPath = (sessionId) => join(GOALS_DIR, `${sessionId}.json`);

/** activation 位进程本地(DSH 语义),不持久化;重启即 disarmed。 */
const activationBySession = new Map();

function readGoal(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(goalPath(sessionId), "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeGoal(sessionId, goal) {
  mkdirSync(GOALS_DIR, { recursive: true });
  writeFileSync(goalPath(sessionId), JSON.stringify(goal, null, 2), "utf8");
}

function isPositiveInt(n) {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
}

class GoalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}

/** 应用一次目标操作,产出 revision+1 的新快照(纯函数,对齐 pi goal-fold)。 */
function applyGoalOperation(cur, op, changes, now) {
  if (op === "create") {
    if (cur !== null && cur.phase !== "complete") {
      throw new GoalError("GOAL_ALREADY_EXISTS", "goal create requires no active current goal");
    }
    const objective = changes.objective;
    if (typeof objective !== "string" || objective.trim().length === 0) {
      throw new GoalError("GOAL_INVALID_OBJECTIVE", "goal create requires a non-empty objective");
    }
    const maxGoalRounds = changes.maxGoalRounds ?? 8;
    if (!isPositiveInt(maxGoalRounds)) {
      throw new GoalError("GOAL_INVALID_MAX_ROUNDS", "goal create maxGoalRounds must be a positive safe integer");
    }
    return {
      id: `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      revision: 1,
      objective: objective.trim(),
      phase: "active",
      maxGoalRounds,
      roundsStarted: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (cur === null) throw new GoalError("GOAL_NOT_FOUND", `goal ${op} requires a current goal`);
  const revision = cur.revision + 1;

  switch (op) {
    case "edit": {
      if (changes.blockedReason !== undefined) {
        throw new GoalError("GOAL_INVALID_EDIT", "blocked_reason is valid only with action blocked");
      }
      const objective = changes.objective !== undefined ? changes.objective : cur.objective;
      const maxGoalRounds = changes.maxGoalRounds !== undefined ? changes.maxGoalRounds : cur.maxGoalRounds;
      if (typeof objective !== "string" || objective.trim().length === 0) {
        throw new GoalError("GOAL_INVALID_OBJECTIVE", "goal edit requires a non-empty objective");
      }
      if (!isPositiveInt(maxGoalRounds)) {
        throw new GoalError("GOAL_INVALID_MAX_ROUNDS", "goal edit maxGoalRounds must be a positive safe integer");
      }
      return { ...cur, revision, objective: objective.trim(), maxGoalRounds, updatedAt: now };
    }
    case "pause":
      if (cur.phase !== "active") throw new GoalError("GOAL_INVALID_TRANSITION", "goal pause has an invalid phase transition");
      return { ...cur, revision, phase: "paused", updatedAt: now };
    case "resume": {
      const resumable = new Set(["active", "paused", "blocked"]);
      if (!resumable.has(cur.phase) || cur.roundsStarted >= cur.maxGoalRounds) {
        throw new GoalError("GOAL_INVALID_TRANSITION", "goal resume has an invalid phase transition or exhausted round budget");
      }
      return { ...cur, revision, phase: "active", updatedAt: now };
    }
    case "complete":
      if (cur.phase === "complete") throw new GoalError("GOAL_INVALID_TRANSITION", "goal complete has an invalid phase transition");
      return { ...cur, revision, phase: "complete", updatedAt: now };
    case "block": {
      if (cur.phase !== "active") throw new GoalError("GOAL_INVALID_TRANSITION", "goal block has an invalid phase transition");
      if (!changes.blockedReason || changes.blockedReason.message.trim().length === 0) {
        throw new GoalError("GOAL_INVALID_BLOCK_REASON", "goal block requires a concrete blocked_reason");
      }
      return {
        ...cur,
        revision,
        phase: "blocked",
        blockedReason: { code: changes.blockedReason.code, message: changes.blockedReason.message.trim() },
        updatedAt: now,
      };
    }
    default:
      throw new GoalError("GOAL_INVALID_TRANSITION", `unknown goal operation ${String(op)}`);
  }
}

/** DSH goalValue:稳定紧凑模型结果,activation 是观察不是重放状态。 */
function goalValue(sessionId, goal) {
  if (goal === null) return { goal: null };
  const activation = activationBySession.get(sessionId) ?? "disarmed";
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined ? {} : {
        blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message },
      }),
    },
    activation,
  };
}

const sessionIdOf = (exec) => String(exec?.agent?.session?.id ?? "");
const textOf = (v) => JSON.stringify(v);

const GET_DESCRIPTION =
  "Read the current same-session goal, including its exact id/revision, objective, phase, "
  + "rounds, and whether another continuation is armed. Call this before updating a goal.";

const CREATE_DESCRIPTION =
  "Create one persisted same-session completion goal when the current direct human request "
  + "is a long-running objective. Do not use this for trivial single-turn work.";

const UPDATE_DESCRIPTION =
  "Update the exact current goal revision. edit, pause, resume require a direct human request; "
  + "complete and blocked report the terminal state. blocked requires a concrete blocked_reason.";

// ==============================================================================================
// 3. read-claude-md —— agent/pre-step 全局 CLAUDE.md 注入
//    对称 pi 侧 pi-extension:pi 挂 before_agent_start / session_start,dsh 挂 agent/pre-step。
//    只做全局(~/.claude/CLAUDE.md + ~/.claude/rules/ 下全部 .md,递归);project 级由 dsh 自带
//    agent-instructions 负责(已从 projectRoot 到 cwd 逐级读 AGENTS.md/CLAUDE.md),两边不重叠。
// ==============================================================================================

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

/** 递归收集 dir 下全部 .md(按文件名字典序,稳定)。目录不存在返回 []。 */
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

/** 发现全局 CLAUDE.md 指令文件:~/.claude/CLAUDE.md + ~/.claude/rules/ 下全部 .md(递归,按路径去重)。 */
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

/** 幂等判据:role + content + source 逐字段相等(对齐 agent-instructions 的 sameContextPayload)。 */
function sameContext(a, b) {
  return a.role === b.role
    && JSON.stringify(a.content) === JSON.stringify(b.content)
    && JSON.stringify(a.source) === JSON.stringify(b.source);
}

// ==============================================================================================
// 4. skill-manager —— fork dsh-skill-filesystem 补「启用/禁用」轴 + 完整列表播报
//    依据 docs/design/skills-layering.md §4.2/§4.4:dsh 的 SkillRegistry 只有「往里加」没有
//    「往外删」,要「关闭」某技能必须在发现阶段过滤。fork 一份带 disabled 名单过滤的发现
//    provider 替换 skill-filesystem(不动 dsh 核心),并把完整列表(含禁用、带 enabled 标志)
//    写播报文件,壳侧 dsh-skill-provider 读它。
// ==============================================================================================

const DISABLED_FILE = join(homedir(), ".dsh", ".my-harness-desktop-disabled-skills.json");
const BROADCAST_FILE = join(homedir(), ".dsh", "desktop-skills.json");

/** 读 disabled 名单(技能名集合);文件缺失/损坏回空集合,不炸 dsh。 */
function readDisabledSkills() {
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
    sourceDir: candidate.source,
    filePath: candidate.path,
  };
}

function writeBroadcast(skills) {
  try {
    mkdirSync(dirname(BROADCAST_FILE), { recursive: true });
    writeFileSync(BROADCAST_FILE, JSON.stringify(skills, null, 2), "utf8");
  } catch (err) {
    console.error("[desktop-skill] broadcast failed:", err?.message ?? String(err));
  }
}

// ==============================================================================================
// 统一 apply —— 四块能力挂在同一个插件树上。
// ==============================================================================================

export function apply(ctx, config = {}) {
  // ---- ask:ask_user_question ----
  ctx.tools.register({
    name: "ask_user_question",
    label: "Ask User",
    description: ASK_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask the user before continuing.",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string", description: "Stable id for this question; echoed in the answer." },
              question: { type: "string", description: "The specific question to ask the user." },
              header: { type: "string", description: 'Optional short heading, such as "Confirm" or "Choose Mode".' },
              options: {
                type: "array",
                description: "Optional choices to show the user. If you recommend one, put it first.",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    label: { type: "string", description: "Short user-facing option label." },
                    description: { type: "string", description: "One sentence explaining the tradeoff or impact." },
                  },
                },
              },
              multi_select: { type: "boolean", description: "Whether the user may select more than one option. Defaults to false." },
            },
            required: ["id", "question"],
          },
        },
      },
      required: ["questions"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          answers: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                selected: { type: "array", items: { type: "string" } },
                custom: { type: "string" },
              },
              required: ["id", "selected"],
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      try {
        const questions = Array.isArray(args?.questions) ? args.questions : [];
        if (questions.length === 0) return { answers: [] };
        const requestId = randomUUID();
        mkdirSync(QUESTIONS_DIR, { recursive: true });
        writeFileSync(
          questionPath(requestId),
          JSON.stringify({
            requestId,
            sessionId: String(exec?.agent?.session?.id ?? ""),
            questions,
          }),
          "utf8",
        );
        const result = await waitForAnswer(requestId, exec?.signal);
        if (result.cancelled) return { answers: null, cancelled: true };
        return { answers: result.answers ?? [] };
      } catch (err) {
        return { answers: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // ---- goal:get_goal ----
  ctx.tools.register({
    name: "get_goal",
    label: "Get Goal",
    description: GET_DESCRIPTION,
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: textOf(value) }],
    },
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec);
      const goal = readGoal(sessionId);
      return goalValue(sessionId, goal);
    },
  });

  // ---- goal:create_goal ----
  ctx.tools.register({
    name: "create_goal",
    label: "Create Goal",
    description: CREATE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The concrete completion objective." },
        max_goal_rounds: { type: "number", description: "Optional positive safe-integer limit." },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: textOf(value) }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      try {
        const cur = readGoal(sessionId);
        const next = applyGoalOperation(cur, "create", {
          objective: args.objective,
          maxGoalRounds: args.max_goal_rounds,
        }, Date.now());
        writeGoal(sessionId, next);
        activationBySession.set(sessionId, "armed");
        return goalValue(sessionId, next);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // ---- goal:update_goal ----
  ctx.tools.register({
    name: "update_goal",
    label: "Update Goal",
    description: UPDATE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "Exact id returned by get_goal." },
        revision: { type: "number", description: "Exact positive revision returned by get_goal." },
        action: { type: "string", enum: ["edit", "pause", "resume", "complete", "blocked"], description: "edit | pause | resume | complete | blocked" },
        objective: { type: "string", description: "Replacement objective; valid only with action edit." },
        max_goal_rounds: { type: "number", description: "Replacement cap; valid only with action edit." },
        blocked_reason: { type: "string", description: "Concrete blocking condition; required only with action blocked." },
      },
      required: ["goal_id", "revision", "action"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: textOf(value) }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      try {
        const action = args.action;
        if (!["edit", "pause", "resume", "complete", "blocked"].includes(action)) {
          throw new GoalError("GOAL_INVALID_EDIT", "update_goal requires a valid action");
        }
        const goalId = args.goal_id;
        const revision = args.revision;
        if (typeof goalId !== "string" || goalId.length === 0 || !Number.isSafeInteger(revision) || revision < 1) {
          throw new GoalError("GOAL_STALE_REVISION", "goal_id must be non-empty and revision must be a positive safe integer");
        }
        const cur = readGoal(sessionId);
        if (cur === null) throw new GoalError("GOAL_NOT_FOUND", "update_goal requires a current goal");
        if (cur.id !== goalId || cur.revision !== revision) {
          throw new GoalError("GOAL_STALE_REVISION", "goal_id/revision does not match the current goal (compare-and-set)");
        }
        const op = action === "blocked" ? "block" : action;
        if (action === "blocked" && cur.roundsStarted < BLOCKED_AFTER_CONSECUTIVE_ROUNDS) {
          throw new GoalError("GOAL_TOOL_BLOCK_THRESHOLD",
            `blocked requires at least ${BLOCKED_AFTER_CONSECUTIVE_ROUNDS} consecutive goal rounds`);
        }
        const next = applyGoalOperation(cur, op, {
          ...(args.objective !== undefined ? { objective: args.objective } : {}),
          ...(args.max_goal_rounds !== undefined ? { maxGoalRounds: args.max_goal_rounds } : {}),
          ...(args.blocked_reason !== undefined ? { blockedReason: { code: "model-reported", message: args.blocked_reason } } : {}),
        }, Date.now());
        writeGoal(sessionId, next);
        activationBySession.set(sessionId, action === "resume" ? "armed"
          : action === "pause" || action === "complete" || action === "blocked" ? "disarmed"
            : activationBySession.get(sessionId) ?? "disarmed");
        return goalValue(sessionId, next);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // ---- read-claude-md:agent/pre-step 注入全局 CLAUDE.md ----
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
      // 严禁复用 dsh 的 agent-instructions 命名空间(尤其 baseline:true):那是 dsh 工作区基线
      // 的专属标记,其 agent-instructions 插件据此反查「可见基线」并直接读 changes 字段——
      // 这里只注入全局 ~/.claude 指令、从不带 changes/baselineIdentity,误用该标记会让 dsh
      // 第二回合在 visibleBaseline.changes.flatMap() 处 changes=undefined 整回合崩溃
      // (「dsh 不能发送第二条语句」的真正根因,本地源码裸 RPC 复现)。改用独立 plugin kind:
      // dsh 不识别为基线(不再崩)、壳翻译器仍按非 user 丢弃(不进时间线气泡)、模型照常可见。
      source: { kind: "plugin", plugin: "my-harness-fit-dsh-extension", form: "instructions" },
    };

    if (decision.messages.some((m) => sameContext(m, desired))) return decision;

    const lastClaimedIndex = decision.messages.findLastIndex((m) => messages.includes(m));
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
    return { kind: "enter", messages: entered };
  });

  // ---- skill-manager:fork skill-filesystem 补启用/禁用轴 + 播报 ----
  let inner;
  let controlRef;

  const claudeSkills = join(homedir(), ".claude", "skills");
  const customSkillDirs = [...new Set([...(config.customSkillDirs ?? []), claudeSkills])];
  // providerName 必须避开 agent-core(dsh-agent-spine-demo)经 ctx.plugin(SkillFileSystem)
  // 已全局注册的默认名 "filesystem"——新 scoped 注册表对同层重名直接抛错,重名会让 dsh
  // 进程 boot 崩、会话流整体不可用(根因)。用桌面专属名,不抢核心 "filesystem"。
  const effectiveConfig = { ...config, customSkillDirs, providerName: config.providerName ?? "desktop-filesystem" };

  const disposeProvider = ctx.skills.registerProvider((control) => {
    controlRef = control;
    inner = new FileSystemSkillProvider(ctx, control, effectiveConfig);
    return {
      name: inner.name,
      async list(options) {
        const obs = await inner.list(options);
        const candidates = Array.isArray(obs) ? obs : obs.candidates;
        const disabled = readDisabledSkills();
        return candidates.filter((c) => !disabled.has(c.name));
      },
      async get(candidate, options) {
        return inner.get(candidate, options);
      },
    };
  });

  const broadcast = async (cwd) => {
    if (!inner) return;
    try {
      const obs = await inner.list({ cwd });
      const candidates = Array.isArray(obs) ? obs : obs.candidates;
      const disabled = readDisabledSkills();
      writeBroadcast(candidates.map((c) => toSkillInfo(c, disabled)));
    } catch (err) {
      console.error("[desktop-skill] broadcast error:", err?.message ?? String(err));
    }
  };

  ctx.on("skills/change", () => { void broadcast(process.cwd()); });

  const watcher = watchFile(DISABLED_FILE, () => {
    try { controlRef?.invalidate(); } catch { /* ignore */ }
  });

  void broadcast(process.cwd());

  ctx.effect(function* () {
    yield () => {
      try { watcher.close(); } catch { /* ignore */ }
      try { disposeProvider(); } catch { /* ignore */ }
    };
  }, "my-harness-fit-dsh-extension");
}
