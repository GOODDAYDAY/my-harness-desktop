// @vitest-environment jsdom
// ContextUsageBar 的 DOM 断言 —— 钉住文件注释里声明的**三级诚实态**契约:
//   ① stats null(内核没起)→ 弱化占位 + "—"
//   ② used/limit 任一未知(压缩后待测、窗口未至)→ 空条 + "—",**未知不显示成 0%**
//   ③ 已知 → 百分比;>80% → 警告色
//   ④ limit 的窗口**fallback**:文件聚合基线的 contextWindow 为 0(文件无此字段)= 未知,
//      回落到当前模型配置窗口
//
// 为什么先测它:该插件(insight/token-stats)此前零 e2e、零单测;这个组件是最小、且带明确
// 语义契约的一处。i18n 用真实字典形状(断言跑真文案,不断言 key)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// 共享 store 只读:按选择器从假 state 取值(与生产调用形状一致:useSessionStore((s) => s.stats))
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@my-harness-desktop/react", () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) => sel(store.state),
}));
// 真实字典形状:{{used}}/{{limit}} 插值成 "已用 X / Y"
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_k: string, o?: { used?: string; limit?: string }) => `已用 ${o?.used} / ${o?.limit}`,
  }),
}));
// HoverTip 原样透传 children(它只是包一层 tooltip;测试关心的是条与数字)
vi.mock("./hover-tip", () => ({ HoverTip: ({ children }: { children: React.ReactNode }) => children }));

import { ContextUsageBar } from "./context-usage-bar";

// DOM 结构:HoverTip(透传)> 外层 flex 容器 > 轨道 > **条** + 百分比 span。
// 故 div 序号:0=容器,1=轨道,2=条 —— 断言要取 2(取 1 会读到轨道,永远没有 width/background)。
const pctText = (c: HTMLElement): string => c.querySelector("span")!.textContent!;
const barWidth = (c: HTMLElement): string => (c.querySelectorAll("div")[2] as HTMLElement).style.width;
const barBg = (c: HTMLElement): string => (c.querySelectorAll("div")[2] as HTMLElement).style.background;
const rootOpacity = (c: HTMLElement): string => (c.querySelectorAll("div")[0] as HTMLElement).style.opacity;

beforeEach(() => { store.state = {}; });

describe("ContextUsageBar(上下文占用条的三级诚实态)", () => {
  it("stats 为 null(内核没起):显示 — 且弱化(opacity 0.4),不显示 0%", () => {
    store.state = { stats: null, snapshot: null };
    const { container } = render(<ContextUsageBar />);
    expect(pctText(container)).toBe("—");
    expect(rootOpacity(container), "未起内核时未弱化").toBe("0.4");
    expect(barWidth(container)).toBe("0%");
  });

  it("used 未知:显示 — 且条为空 —— **未知不冒充 0%**", () => {
    store.state = { stats: { contextUsage: { tokens: null, contextWindow: 1000, percent: null } }, snapshot: null };
    const { container } = render(<ContextUsageBar />);
    expect(pctText(container), "未知被显示成了具体数字").toBe("—");
    expect(barWidth(container)).toBe("0%");
  });

  it("limit 未知(contextWindow 为 0 且模型窗口也没配):仍显示 —,不冒充 0%", () => {
    store.state = {
      stats: { contextUsage: { tokens: 500, contextWindow: 0, percent: null } },
      snapshot: { state: { model: { contextWindow: 0 } } },
    };
    const { container } = render(<ContextUsageBar />);
    expect(pctText(container), "limit 未知却算出了百分比").toBe("—");
  });

  it("已知 used/limit:显示四舍五入百分比,且未超 80% 用主色", () => {
    store.state = {
      stats: { contextUsage: { tokens: 200, contextWindow: 1000, percent: null } },
      snapshot: null,
    };
    const { container } = render(<ContextUsageBar />);
    expect(pctText(container)).toBe("20%");
    expect(barWidth(container)).toBe("20%");
    expect(barBg(container)).toBe("var(--color-primary)");
  });

  it("超过 80%:条变警告色(仍显示百分比)", () => {
    store.state = {
      stats: { contextUsage: { tokens: 900, contextWindow: 1000, percent: null } },
      snapshot: null,
    };
    const { container } = render(<ContextUsageBar />);
    expect(pctText(container)).toBe("90%");
    expect(barBg(container), ">80% 未切警告色").toBe("var(--color-accent-warning)");
  });

  it("窗口 fallback:contextUsage.contextWindow 为 0 时回落到模型配置窗口", () => {
    store.state = {
      stats: { contextUsage: { tokens: 500, contextWindow: 0, percent: null } },
      snapshot: { state: { model: { contextWindow: 1000 } } },
    };
    const { container } = render(<ContextUsageBar />);
    expect(pctText(container), "未回落到模型配置窗口").toBe("50%");
  });
});
