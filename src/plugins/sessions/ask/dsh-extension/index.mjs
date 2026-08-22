/**
 * ask 的 dsh 内核插件 —— ask_user_question 工具（文件侧车桥实现，同轮回填）。
 *
 * 设计 docs/design/goal-ask-pi-port.md §5 + 文件侧车桥方案。不改 deepseek-harness：
 * 不依赖 ctx.userQuestions（它需要 SDK server 补 answer 通道），也不依赖 agent.steer
 * （SDK server 只暴露 followup=下一轮排队）。改为进程内阻塞 + 文件侧车：
 *
 *   execute 写 ~/.pi/agent/.my-harness-desktop-questions/<id>.json（问句 + 选项）
 *   → 轮询 <id>.answer.json 直到桌面壳写入答案（execute 阻塞 = 同轮暂停）
 *   → 读到答案 resolve，把答案作为工具结果回灌模型（同轮继续）。
 *
 * 超时 60s（与 pi extensionUI 对齐）：无答案则返回 cancelled，不永久挂起。
 * 侧车目录选 ~/.pi/agent（桌面壳 configFile 白名单可及，供壳侧桥接读写）。
 *
 * 零 import dsh 内核包（手写窄形状，与 read-claude-md/dsh 扩展同纪律），只用 node 内建模块。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "desktop-ask";

// cordis 服务依赖声明:apply 里访问 ctx.tools 必须先在此注入(否则插件树加载期抛
// "cannot get property tools without inject" → 整个 dsh 内核崩溃)。对齐 dsh-schedule 的 inject 纪律。
export const inject = ["tools"];

const QUESTIONS_DIR = join(homedir(), ".pi", "agent", ".my-harness-desktop-questions");
const ASK_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 200;

const questionPath = (id) => join(QUESTIONS_DIR, `${id}.json`);
const answerPath = (id) => join(QUESTIONS_DIR, `${id}.answer.json`);

/** 轮询答案文件直到出现或超时；返回 { answers } 或 { cancelled: true }。 */
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

const description =
  "Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. "
  + "Send one or more questions, each with a stable id that will be echoed in the answer.";

export function apply(ctx) {
  ctx.tools.register({
    name: "ask_user_question",
    label: "Ask User",
    description,
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
}
