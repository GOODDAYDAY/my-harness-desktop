// @vitest-environment jsdom
// SessionStatsTitlebar 的 DOM 断言 —— 钉住两处**文档化契约**:
//   ① 三级诚实态:stats null(内核没起)→ 整行弱化且四项全 "—"
//   ② **「上传」= input + cacheRead + cacheWrite**(见文件注释:"内核口径 input 只是未命中缓存的
//      新 token(实测每轮个位数),prompt 主体走 cacheRead/cacheWrite——必须是三项之和,
//      否则**差四个数量级**")。这条最值得钉:有人把它"简化"成只取 input,不会报错,
//      只会静默少四个数量级——正是本会话反复抓到的那类"静默错"。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@my-harness-desktop/react", () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) => sel(store.state),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("./hover-tip", () => ({ HoverTip: ({ children }: { children: React.ReactNode }) => children }));

import { SessionStatsTitlebar } from "./stats-titlebar";

/** 取符号后紧跟的值(如 "↑12.0k" → "12.0k");找不到返回 null。 */
const valueOf = (c: HTMLElement, sym: string): string | null => {
  const m = new RegExp(`${sym}([^↑↓⚡Σ]*)`).exec(c.textContent ?? "");
  return m ? m[1].trim() : null;
};

beforeEach(() => { store.state = {}; });

describe("SessionStatsTitlebar(次级统计行)", () => {
  it("stats 为 null(内核没起):四项全为 —,不显示 0", () => {
    store.state = { stats: null };
    const { container } = render(<SessionStatsTitlebar />);
    for (const sym of ["↑", "↓", "⚡", "Σ"]) {
      expect(valueOf(container, sym), `${sym} 在未起内核时没显示占位`).toBe("—");
    }
  });

  it("「上传」是 input + cacheRead + cacheWrite 三项之和(差四个数量级的那个坑)", () => {
    // input 极小(未命中缓存的新 token),主体在 cacheRead/cacheWrite —— 真实分布
    store.state = {
      stats: { tokens: { input: 5, cacheRead: 10000, cacheWrite: 2000, output: 3000, total: 15005 }, tps: null },
    };
    const { container } = render(<SessionStatsTitlebar />);
    expect(valueOf(container, "↑"), "上传被算成了只取 input(少四个数量级)").toBe("12.0k");
  });

  it("↓ 取 output、Σ 取 total(各取自己的字段,不串)", () => {
    store.state = {
      stats: { tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 3000, total: 15005 }, tps: null },
    };
    const { container } = render(<SessionStatsTitlebar />);
    expect(valueOf(container, "↓")).toBe("3.0k");
    expect(valueOf(container, "Σ")).toBe("15.0k");
    expect(valueOf(container, "↑")).toBe("1");   // 三项之和 = 1
  });

  it("⚡ 取 tps 保留一位小数;tps 为 null 时显示 —(不冒充 0.0)", () => {
    store.state = { stats: { tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }, tps: 12.345 } };
    const { container } = render(<SessionStatsTitlebar />);
    expect(valueOf(container, "⚡")).toBe("12.3");

    store.state = { stats: { tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }, tps: null } };
    const { container: c2 } = render(<SessionStatsTitlebar />);
    expect(valueOf(c2, "⚡"), "tps 未知被显示成了 0.0").toBe("—");
  });
});
