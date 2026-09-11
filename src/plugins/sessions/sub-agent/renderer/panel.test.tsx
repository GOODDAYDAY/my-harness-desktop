// @vitest-environment jsdom
// SubAgentPanel 的 DOM 断言 —— 钉住 `elapsed` 的**格式化与时间边界** + 两处条件渲染:
//   ① `<60s → "Ns"`;`>=60s → "Nm Ss"`(90s → "1m30s",120s → **"2m0s"**,不是 "2m")
//   ② 用 `finishedAt ?? now`:已结束的子显示**冻结**的时长,不是一直涨
//   ③ `Math.max(0, …)`:时长为负(时钟回拨/未来时间)时**夹到 0**,不显示负数
//   ④ `running` 才出「中止」按钮;非 running 不出
//   ⑤ 无 orchestrator → null;无子 → 空态文案
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

type Rec = { addr: string; name: string; sessionPath: string; cwd: string; status: string; spawnedAt: number; finishedAt?: number };
const h = vi.hoisted(() => ({
  subs: [] as Rec[],
  noOrch: false,
  aborted: [] as string[],
  opened: [] as unknown[],
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({ bus: { sessionAbort: (a: string) => { h.aborted.push(a); } } }),
  usePluginId: () => "sub-agent",
  ListItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
}));
vi.mock("./orchestrator-singleton", () => ({
  ensureOrchestrator: () => (h.noOrch ? null : { getSubs: () => h.subs, onChange: () => () => {} }),
}));
vi.mock("./dialog-state", () => ({ openDialogFor: async (...a: unknown[]) => { h.opened.push(a); } }));

import { SubAgentPanel } from "./panel";

/** 造一条记录:spawnedAt 距 now(真实 Date.now())为 spawnAgoMs 之前;finishedAt 可选。 */
const rec = (n: number, spawnAgoMs: number, status = "running", finishAgoMs?: number): Rec => ({
  addr: `a${n}`, name: `子${n}`, sessionPath: `/s/${n}`, cwd: "/proj", status,
  spawnedAt: Date.now() - spawnAgoMs,
  ...(finishAgoMs !== undefined ? { finishedAt: Date.now() - finishAgoMs } : {}),
});

beforeEach(() => { h.subs = []; h.noOrch = false; h.aborted = []; h.opened = []; });

describe("SubAgentPanel(子代理面板)", () => {
  it("无 orchestrator → null;无子 → 空态文案", () => {
    h.noOrch = true;
    expect(render(<SubAgentPanel />).container).toBeEmptyDOMElement();
    h.noOrch = false;
    render(<SubAgentPanel />);
    expect(screen.getByText("sub-agent.panel.empty")).toBeInTheDocument();
  });

  it("时长格式化:不足 60s 用 Ns", () => {
    h.subs = [rec(1, 12_000)];
    render(<SubAgentPanel />);
    expect(screen.getByText(/12s/)).toBeInTheDocument();
  });

  it("时长格式化:超过 60s 用 Nm Ss(含 120s → 2m0s,不省略 0 秒)", () => {
    h.subs = [rec(1, 90_000), rec(2, 120_000)];
    render(<SubAgentPanel />);
    expect(screen.getByText(/1m30s/)).toBeInTheDocument();
    expect(screen.getByText(/2m0s/), "120s 没有格式化为 2m0s").toBeInTheDocument();
  });

  it("已结束的子显示**冻结**时长(用 finishedAt,不随 now 增长)", () => {
    // 90s 前启动、10s 前结束 → 应显示 ~80s,而不是 ~90s
    h.subs = [rec(1, 90_000, "done", 10_000)];
    render(<SubAgentPanel />);
    expect(screen.getByText(/1m20s/)).toBeInTheDocument();
    expect(screen.queryByText(/1m30s/), "已结束的子仍在按 now 计时").toBeNull();
  });

  it("时长为负(时钟回拨/未来时间)夹到 0s,不显示负数", () => {
    h.subs = [rec(1, -5_000)];   // spawnedAt 在未来 5s
    render(<SubAgentPanel />);
    // 注意:mock 的 t() 返回 key 本身,而 key(sub-agent.status.running)**含连字符**——
    // 所以不能笼统断言"页面里没有 -"。要断的是**时长那一段**恰好是 0s、且不含负号时长。
    const line = screen.getByText(/子1/).closest("li")!.textContent!;
    expect(line, "负时长没有被夹到 0s").toContain("· 0s");
    expect(line, "显示了负数时长").not.toMatch(/·\s*-\d/);
  });

  it("running 才出「中止」按钮,点击调 sessionAbort(addr);非 running 不出", () => {
    h.subs = [rec(1, 1_000, "running"), rec(2, 1_000, "done")];
    render(<SubAgentPanel />);
    const aborts = screen.getAllByText("sub-agent.panel.abort");
    expect(aborts.length, "非 running 的子也出了中止按钮").toBe(1);
    fireEvent.click(aborts[0]);
    expect(h.aborted).toEqual(["a1"]);
  });

  it("点「打开对话」→ openDialogFor 带上该子的地址与会话路径", async () => {
    h.subs = [rec(3, 1_000)];
    render(<SubAgentPanel />);
    fireEvent.click(screen.getByText("sub-agent.dialog.open"));
    await Promise.resolve();
    expect(h.opened[0]).toEqual([expect.anything(), expect.objectContaining({ addr: "a3", sessionPath: "/s/3", cwd: "/proj" })]);
  });
});
