/**
 * ask-extension —— pi 底座 extension：ask_user_question 工具（DSH dsh-tool-ask-user 的 pi 移植）。
 *
 * 设计 docs/design/goal-ask-pi-port.md §5。语义对齐 DSH：工具名/入参/出参一字不差，
 * 只有 execute 内部把 DSH 的 ctx.userQuestions.ask 换成 pi 的 ctx.ui.select/input
 * （RPC 安全原语，走 extension_ui_request/extension_ui_response 帧）。
 *
 * 决策 1A：DSH 的 multi_select 本期降级为单选——每题一次 ctx.ui.select，
 * 自定义答案经"Type something."哨兵选项转入 ctx.ui.input。multi_select 字段仍进 schema（对齐契约），
 * 但渲染层不呈现复选框。
 *
 * 类型不 import 官方 @earendil-works/pi-coding-agent（底座 node_modules 里的类型仓库 tsconfig
 * 够不到）——手写窄结构，与 toolgate/subagent-extension/llm-recorder 同纪律。
 * 本目录由 piExtensionEnsure 随插件启停同步到 ~/.pi/agent/extensions/ask/。
 */

interface AskOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options?: AskOption[];
  multi_select?: boolean;
}

interface AskParams {
  questions: AskQuestion[];
}

interface AskAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

interface AskToolResult {
  content: { type: "text"; text: string }[];
  details?: { answers: AskAnswer[] };
  isError?: boolean;
}

interface AskUi {
  select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
}

interface AskExecuteContext {
  mode?: string;
  ui: AskUi;
}

interface AskToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  executionMode?: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: AskExecuteContext,
  ): Promise<AskToolResult>;
}

interface AskApi {
  registerTool(tool: AskToolDefinition): void;
}

const DESCRIPTION =
  "Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. "
  + "Send one or more questions, each with a stable id that will be echoed in the answer.";

/** 自定义答案哨兵选项（与 DSH question.ts 的 "Type something." 同语义）。 */
const CUSTOM_SENTINEL = "Type something.";

function error(text: string): AskToolResult {
  return { content: [{ type: "text", text }], isError: true, details: { answers: [] } };
}

function ok(answers: AskAnswer[], text?: string): AskToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify({ answers }) }],
    details: { answers },
  };
}

export default function ask(pi: AskApi): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description: DESCRIPTION,
    executionMode: "sequential",
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
                description: "Optional choices to show the user. If you recommend one, put it first and append \"(Recommended)\" to that label.",
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
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      try {
        if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
          return error("Error: UI not available (non-interactive mode)");
        }
        const params = rawParams as unknown as AskParams;
        if (!Array.isArray(params.questions) || params.questions.length === 0) {
          return ok([], JSON.stringify({ answers: [] }));
        }
        const answers: AskAnswer[] = [];
        for (const q of params.questions) {
          const selected: string[] = [];
          let custom: string | undefined;
          if (Array.isArray(q.options) && q.options.length > 0) {
            const labels = q.options.map((o) => o.label);
            const picked = await ctx.ui.select(q.question, [...labels, CUSTOM_SENTINEL]);
            if (picked === undefined) {
              return { content: [{ type: "text", text: "User cancelled the question" }], details: { answers } };
            }
            if (picked === CUSTOM_SENTINEL) {
              custom = await ctx.ui.input(`${q.question} (custom answer)`);
            } else {
              selected.push(picked);
            }
          } else {
            custom = await ctx.ui.input(q.question);
          }
          answers.push(custom !== undefined ? { id: q.id, selected, custom } : { id: q.id, selected });
        }
        return ok(answers);
      } catch (err) {
        return error(`ask_user_question failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
