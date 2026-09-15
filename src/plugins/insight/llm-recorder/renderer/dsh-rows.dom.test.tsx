// @vitest-environment jsdom
// 面板渲染 **DSH 形状的行**（形状词典那半边）—— DOM 级守卫。
//
// 为什么非有不可：写侧换了数据面之后，盘上是 dsh 原生形状（reasoning / tool-call / parameters /
// inputTokens），读侧此前只认 provider 原生形状。两侧各自单测都绿、拼起来照样能空成一片——
// 「数据层对 ≠ DOM 对」（skill §10）。本文件断言的是**真实渲染出来的结构**，并且用真字典跑真文案
// （不是断言 i18n key），文案改了这里必须跟着改。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dict = JSON.parse(
  readFileSync(join(__dirname, "../locales/zh-CN/panel.json"), "utf8"),
) as Record<string, string>;

const h = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const raw = dict[key] ?? key;
      if (!vars) return raw;
      return Object.entries(vars).reduce((s, [k, v]) => s.replace(`{{${k}}}`, String(v)), raw);
    },
  }),
}));

vi.mock("@my-harness-desktop/react", async () => {
  const React = await import("react");
  const ctx = {
    pluginId: "llm-recorder",
    fs: {
      listDir: async () => [...h.files.keys()].map((name) => ({ name, isDir: false })),
      readFile: async (p: string) => {
        const name = p.split("/").pop() ?? "";
        if (!h.files.has(name)) throw new Error(`no such file: ${name}`);
        return h.files.get(name)!;
      },
    },
    sessions: { onEvent: () => () => { /* 本文件不测增量 */ } },
  };
  return {
    usePluginContext: () => ctx,
    useUiStore: <T,>(sel: (s: { currentCwd: string; currentSessionPath: string }) => T): T =>
      sel({ currentCwd: "/proj", currentSessionPath: "/kernels/dsh/sessions/sid-1" }),
    EmptyState: ({ title, description }: { title: string; description?: string }) =>
      React.createElement("div", null, title, description ? React.createElement("p", null, description) : null),
    Button: ({ children }: { children?: React.ReactNode }) => React.createElement("button", null, children),
    SettingsSection: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
    useBlockRenderers: () => [],
    resolveBlockRenderer: () => undefined,
    resolveBlockRendererComponent: () => undefined,
  };
});

import { RecordsTab } from "./index";

const SHARD = "sid-1.jsonl"; // == currentSessionPath 的 basename（dsh 的会话路径就是 sid）

/** dsh 执行面落下的请求行：GenerateOptions 原样投影（system 是字符串、工具是 parameters）。 */
const DSH_REQUEST = JSON.stringify({
  seq: 1, ts: 1_700_000_000_000, kind: "request", turnIndex: 1,
  payload: {
    provider: "us-new",
    model: "deepseek-v4-pro",
    messages: [
      { id: "m1", role: "user", content: [{ type: "text", text: "看一下目录" }] },
      { id: "m2", role: "assistant", content: [{ type: "reasoning", text: "先列目录" }, { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' }] },
    ],
    system: "你是 Acme 的助手。",
    tools: [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string", description: "要跑的命令" } }, required: ["command"] } }],
    temperature: 0.3,
    sessionId: "sid-1",
  },
});

/** dsh 的响应行：没有 status（内核不给），message 是被记录侧组装出来的。 */
const DSH_RESPONSE = JSON.stringify({
  seq: 1, ts: 1_700_000_001_000, kind: "response", durationMs: 1200,
  message: {
    role: "assistant", provider: "us-new", model: "deepseek-v4-pro",
    stopReason: "tool-calls",
    usage: { inputTokens: 1200, outputTokens: 34, cacheReadTokens: 900 },
    content: [{ type: "reasoning", text: "先列目录" }, { type: "text", text: "好的，我看一下" }],
  },
});

beforeEach(() => {
  h.files = new Map([[SHARD, `${DSH_REQUEST}\n${DSH_RESPONSE}\n`]]);
});

/** 展开第 1 行（点行头 = 展开详情）。 */
async function expandFirstRow(): Promise<void> {
  const seq = await screen.findByText("#1");
  fireEvent.click(seq.closest("div")!);
  await screen.findByText("请求");
}

describe("请求记录面板:DSH 形状的行", () => {
  it("DSH 的完整请求在 DOM 上摊开成 System / 工具定义 / 消息历史 三段", async () => {
    render(<RecordsTab isActive={true} />);
    await expandFirstRow();

    // provider / model 两栏（dsh 的 provider 是独立字段）
    expect(screen.getAllByText("provider"), "provider 单独成行，不该在参数列表里再画一遍").toHaveLength(1);
    expect(screen.getByText("us-new")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v4-pro")).toBeInTheDocument();
    // system（dsh 给的是裸字符串）
    expect(screen.getByText("System 提示")).toBeInTheDocument();
    // 工具定义：parameters（不是 input_schema）也要认出来，并列出参数名/类型
    expect(screen.getByText("工具定义")).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
    // 消息历史：两条消息，块类型按形状词典投影（reasoning → 思考、tool-call → 工具调用）
    expect(screen.getByText("消息历史")).toBeInTheDocument();
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.getByText("assistant")).toBeInTheDocument();
    // 原始 JSON 保底折叠：请求侧与响应侧各一个（两半都能退回原文）
    expect(screen.getAllByText("原始 JSON")).toHaveLength(2);
  });

  it("没有 HTTP status 的响应行显示结束原因（tool-calls），不再是一个无意义的破折号", async () => {
    render(<RecordsTab isActive={true} />);
    await screen.findByText("#1");
    expect(screen.getByText("tool-calls"), "dsh 不给 status，状态列应回落 stopReason").toBeInTheDocument();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("响应内容摊开成块：思考 + 文本，用量按 dsh 键名读出", async () => {
    render(<RecordsTab isActive={true} />);
    await expandFirstRow();
    expect(screen.getByText("响应")).toBeInTheDocument();
    expect(screen.getAllByText("思考").length).toBeGreaterThan(0);
    expect(screen.getAllByText("文本").length).toBeGreaterThan(0);
    // 用量：↑1.2k ↓34 ⇄900（dsh 的 inputTokens/outputTokens/cacheReadTokens）。
    // 行头摘要与详情明细各一份（有意：行内先看量级，展开看细分），所以是 getAllByText。
    expect(screen.getAllByText(/↑1\.2k/).length).toBeGreaterThan(0);
  });

  it("★ 失败行（只有 error、没有 status）必须标失败，并给出失败原因", async () => {
    h.files = new Map([[SHARD, `${DSH_REQUEST}\n${JSON.stringify({
      seq: 1, ts: 1_700_000_002_000, kind: "response", durationMs: 30,
      error: { kind: "error", code: "RATE_LIMIT", message: "too many requests" },
    })}\n`]]);
    render(<RecordsTab isActive={true} />);
    await screen.findByText("#1");
    // 行头必须有失败标记（此前只看 status，dsh 的失败行被着成成功色、看不出失败）
    expect(await screen.findByText("失败")).toBeInTheDocument();
    fireEvent.click(screen.getByText("#1").closest("div")!);
    await screen.findByText("请求");
    expect(screen.getByText("RATE_LIMIT: too many requests"), "失败原因要摊在详情里").toBeInTheDocument();
  });

  it("★ 内核没回传响应消息：如实说没有，不许报「未识别的响应形状」（旧版的错报）", async () => {
    h.files = new Map([[SHARD, `${DSH_REQUEST}\n${JSON.stringify({
      seq: 1, ts: 1_700_000_003_000, kind: "response", durationMs: 30,
    })}\n`]]);
    render(<RecordsTab isActive={true} />);
    await expandFirstRow();
    expect(
      screen.getByText(/没有回传响应消息/),
      "「内核没给」与「形状不认识」是两件事，面板必须说对话",
    ).toBeInTheDocument();
    expect(screen.queryByText(/未识别的响应形状/), "空数据不是形状畸形").toBeNull();
  });
});
