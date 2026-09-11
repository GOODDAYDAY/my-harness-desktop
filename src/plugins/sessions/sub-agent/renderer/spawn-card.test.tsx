// @vitest-environment jsdom
// SpawnCard 的 DOM 断言 —— 该插件"批量派活不刷屏"的核心就是**默认折叠**。钉住:
//   ① payload 解析失败 → 什么都不渲染
//   ② **默认折叠**:只显示摘要 + `▸`;**完整 task 不在 DOM 里**
//   ③ 点击 → 展开:`▾` + 完整 task(保留换行) + 「打开/对话」两个按钮
//   ④ 子会话已被删除(`missing`)→ 显示"已删除"提示,**不出**打开/对话按钮(注释里的"问题 C8 优雅降级")
//   ⑤ `summaryOf` 边界:**恰好 40 字符不加省略号**(用的是 `>` 不是 `>=`);41 字符加 `…`
//   ⑥ `summaryOf` 折叠空白:多行/缩进 → 单空格一行
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({
  raw: "" as string,            // messageContentText 的返回值(即被 JSON.parse 的文本)
  status: undefined as string | undefined,
  sessionInfos: null as Record<string, unknown> | null,
  cwd: "/proj",
  opened: [] as unknown[],
}));

vi.mock("@my-harness-desktop/shared", () => ({ messageContentText: () => h.raw }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({ sessions: { setContext: () => {} } }),
  useUiStore: (sel: (s: { currentCwd: string }) => unknown) => sel({ currentCwd: h.cwd }),
  useSessionStore: (sel: (s: { sessionInfos: Record<string, unknown> | null }) => unknown) => sel({ sessionInfos: h.sessionInfos }),
}));
vi.mock("./orchestrator-singleton", () => ({
  peekOrchestrator: () => ({ getSub: () => (h.status === undefined ? undefined : { status: h.status }), onChange: () => () => {} }),
}));
vi.mock("./dialog-state", () => ({ openDialogFor: async (...a: unknown[]) => { h.opened.push(a); } }));

import { SpawnCard } from "./spawn-card";

const spawnPayload = (task: string, sessionPath = "/s/1"): void => {
  h.raw = JSON.stringify({ subagent: "a1", subagent_session: sessionPath, task, name: "分析师" });
};
// 替身要满足真实类型 `MessageRendererProps`(含必填 `streaming`)——本仓基线 typecheck 0。
const msg = { content: "whatever", streaming: false } as never;
const toggle = (): HTMLElement => screen.getAllByRole("button")[0];

beforeEach(() => { h.raw = ""; h.status = undefined; h.sessionInfos = null; h.opened = []; });

describe("SpawnCard(spawn 卡:默认折叠成一行摘要)", () => {
  it("payload 解析失败 → 什么都不渲染", () => {
    h.raw = "not json";
    expect(render(<SpawnCard message={msg} streaming={false} />).container).toBeEmptyDOMElement();
  });

  it("**默认折叠**:显示摘要与 ▸;完整 task 不在 DOM 里", () => {
    // 首行**故意超过 40 字**,好让"第二行"绝不可能出现在折叠摘要里 ——
    // 否则断言会命中摘要本身(摘要就是 task 的前 40 字),那是"断言太宽",不是真缺陷。
    const task = "第一行是一段刻意写得很长的任务描述文本内容用来占满并超过四十个字符的长度上限\n尾部第二行细节";
    spawnPayload(task);
    render(<SpawnCard message={msg} streaming={false} />);
    expect(screen.getByText("▸"), "默认不是折叠态").toBeInTheDocument();
    expect(screen.queryByText(/尾部第二行细节/), "折叠时完整 task 已被渲染").toBeNull();
    expect(screen.queryByText("sub-agent.card.open")).toBeNull();
  });

  it("点击 → 展开:▾ + 完整 task(保留换行) + 打开/对话按钮", () => {
    const task = "第一行\n第二行";
    spawnPayload(task);
    render(<SpawnCard message={msg} streaming={false} />);
    fireEvent.click(toggle());
    expect(screen.getByText("▾")).toBeInTheDocument();
    expect(screen.getByText(/第二行/), "展开后完整 task 未渲染").toBeInTheDocument();
    expect(screen.getByText("sub-agent.card.open")).toBeInTheDocument();
    expect(screen.getByText("sub-agent.card.dialog")).toBeInTheDocument();
  });

  it("子会话已删除 → 出「已删除」提示,不出打开/对话按钮(优雅降级)", () => {
    spawnPayload("任务", "/gone");
    h.sessionInfos = {};            // 已加载但**不含**该路径 → 判定为已删除
    render(<SpawnCard message={msg} streaming={false} />);
    fireEvent.click(toggle());
    expect(screen.getByText("sub-agent.card.deleted")).toBeInTheDocument();
    expect(screen.queryByText("sub-agent.card.open"), "已删除却仍给「打开」按钮").toBeNull();
  });

  it("summaryOf 边界:**恰好 40 字符不加省略号**;41 字符加 …", () => {
    const forty = "x".repeat(40);
    spawnPayload(forty);
    const { unmount } = render(<SpawnCard message={msg} streaming={false} />);
    expect(screen.getByText(forty), "40 字被截断了(边界应为 > 而非 >=)").toBeInTheDocument();
    unmount();

    spawnPayload("x".repeat(41));
    const { container } = render(<SpawnCard message={msg} streaming={false} />);
    expect(container.textContent, "41 字未加省略号").toContain("x".repeat(40) + "…");
  });

  it("summaryOf 折叠空白:多行/缩进 → 单空格一行", () => {
    spawnPayload("  第一行\n\n   第二行  ");
    const { container } = render(<SpawnCard message={msg} streaming={false} />);
    // ⚠ 必须读**原始 textContent**:RTL 的 getByText **默认归一化空白**,
    // 未折叠的 "第一行\n\n   第二行" 对它来说与折叠后的 "第一行 第二行" 一样 ——
    // 用它断言等于"用会把差异抹平的工具去验差异"(实测:去掉折叠后该断言照样绿)。
    const summarySpan = screen.getByText(/第一行/);
    expect(summarySpan.textContent, "空白没有被折叠成单空格一行").toBe("第一行 第二行");
    expect(container.textContent, "摘要里仍含换行/多余空格").not.toMatch(/第一行\s*\n/);
  });
});
