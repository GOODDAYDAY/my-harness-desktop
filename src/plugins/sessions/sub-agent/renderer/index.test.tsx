// @vitest-environment jsdom
// SubAgentSection 的 DOM 断言 —— 钉住文件注释声明的语义 + 一处**off-by-one 边界**:
//   ① **无 orchestrator / 无活跃子 → return null**(注释:"无活跃子时 return null,不占左栏")
//   ② 只列 **running** 的子(其它状态不算"活跃")
//   ③ 最多列 **3** 个(`active.slice(0, 3)`)
//   ④ **恰好 3 个时不出现 "+N" 溢出提示**;超过时 N = 总数 − 3   ← off-by-one 高发处
//   ⑤ 点一行 → `ctx.sessions.setContext(cwd, sessionPath)`;**无 cwd 时不调用**
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

type Sub = { addr: string; name: string; sessionPath: string; status: string };
const h = vi.hoisted(() => ({
  subs: [] as Sub[],
  noOrch: false,
  cwd: null as string | null,
  setContext: [] as unknown[][],
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({ bus: { onMessage: () => () => {} }, sessions: { setContext: (...a: unknown[]) => { h.setContext.push(a); } } }),
  usePluginId: () => "sub-agent",
  useUiStore: (sel: (s: { currentCwd: string | null }) => unknown) => sel({ currentCwd: h.cwd }),
  Section: ({ title, children }: { title: string; children: React.ReactNode }) => <section><h3>{title}</h3>{children}</section>,
  ListItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <li><button type="button" onClick={onClick}>{children}</button></li>
  ),
}));
vi.mock("./orchestrator-singleton", () => ({
  ensureOrchestrator: () => (h.noOrch ? null : { getSubs: () => h.subs, onChange: () => () => {}, handleFrame: () => {} }),
}));

import { SubAgentSection } from "./index";

const sub = (n: number, status = "running"): Sub => ({ addr: `a${n}`, name: `子${n}`, sessionPath: `/s/${n}`, status });

beforeEach(() => { h.subs = []; h.noOrch = false; h.cwd = "/proj"; h.setContext = []; });

describe("SubAgentSection(左栏子代理区块)", () => {
  it("无 orchestrator → 什么都不渲染", () => {
    h.noOrch = true;
    const { container } = render(<SubAgentSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("无活跃子 → 什么都不渲染(不占左栏)", () => {
    h.subs = [];
    const { container } = render(<SubAgentSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("只列 running 的子(非 running 不算活跃)", () => {
    h.subs = [sub(1), sub(2, "done"), sub(3, "failed")];
    render(<SubAgentSection />);
    expect(screen.getByText(/子1/)).toBeInTheDocument();
    expect(screen.queryByText(/子2/), "非 running 的子被列了出来").toBeNull();
    expect(screen.queryByText(/子3/)).toBeNull();
  });

  it("**恰好 3 个时不出现溢出提示**(边界)", () => {
    h.subs = [sub(1), sub(2), sub(3)];
    render(<SubAgentSection />);
    expect(screen.getByText(/子3/)).toBeInTheDocument();
    expect(screen.queryByText(/sectionMore/), "恰好 3 个却显示了 +N").toBeNull();
  });

  it("超过 3 个:只列 3 个,溢出数为 总数−3", () => {
    h.subs = [sub(1), sub(2), sub(3), sub(4), sub(5)];
    const { container } = render(<SubAgentSection />);
    expect(screen.queryByText(/子4/), "列出的超过 3 个").toBeNull();
    expect(container.textContent, "溢出数不是 总数−3").toMatch(/\+2\s*sub-agent\.sectionMore/);
  });

  it("点一行 → setContext(cwd, sessionPath);**无 cwd 时不调用**", () => {
    h.subs = [sub(1)];
    const { unmount } = render(<SubAgentSection />);
    fireEvent.click(screen.getByText(/子1/));
    expect(h.setContext).toEqual([["/proj", "/s/1"]]);

    unmount();
    h.cwd = null;
    h.setContext = [];
    render(<SubAgentSection />);
    fireEvent.click(screen.getByText(/子1/));
    expect(h.setContext, "无 cwd 时仍调用了 setContext").toEqual([]);
  });
});
