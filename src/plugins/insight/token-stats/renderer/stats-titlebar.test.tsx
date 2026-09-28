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
// t 必须支持 {{var}} 插值：`shell.tpsValue` 的文案是 "{{value}} tokens/秒"，
// 只返回 key 的话，"可访问名带上数值"那条断言就测不到真实形状了（会假红）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>): string => {
      const DICT: Record<string, string> = { "shell.tpsValue": "{{value}} tokens/秒" };
      let v = DICT[k] ?? k;
      for (const [name, val] of Object.entries(vars ?? {})) v = v.split(`{{${name}}}`).join(String(val));
      return v;
    },
  }),
}));
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

// 可访问名守卫 —— 实测缺陷（dom-audit.e2e.mjs 抓到）：这四项的可访问名此前**只有裸字形**，
// 屏幕阅读器读到"上箭头 破折号"；而字形含义的唯一解释处是 HoverTip 气泡，那个气泡由
// Radix Tooltip 驱动、trigger 落在没有 tabIndex 的 span 上，键盘用户永远打不开它。
// 于是含义对非鼠标用户完全不可达。现在每项带 aria-label（同一份翻译文案），字形标 aria-hidden。
describe("SessionStatsTitlebar：四项统计的可访问名（非鼠标用户可达）", () => {
  /** 取某一项的外层 span（带 aria-label 的那个）。 */
  const itemOf = (c: HTMLElement, sym: string): HTMLElement | null =>
    [...c.querySelectorAll<HTMLElement>("span[aria-label]")].find((el) => (el.textContent ?? "").includes(sym)) ?? null;

  it("四项都有 aria-label，且含各自的翻译 key（不是空串、不是字形本身）", () => {
    store.state = { stats: null };
    const { container } = render(<SessionStatsTitlebar />);
    const expectKey: Record<string, string> = {
      "↑": "shell.tokensUp", "↓": "shell.tokensDown", "⚡": "shell.tpsTitle", "Σ": "shell.totalTitle",
    };
    for (const [sym, key] of Object.entries(expectKey)) {
      const el = itemOf(container, sym);
      expect(el, `${sym} 这一项没有可访问名（aria-label 缺失）`).toBeTruthy();
      expect(el!.getAttribute("aria-label"), `${sym} 的可访问名应含 ${key}`).toContain(key);
      expect(el!.getAttribute("aria-label")!.length, `${sym} 的可访问名不该只有字形`).toBeGreaterThan(sym.length);
    }
  });

  it("裸字形标了 aria-hidden（避免 AT 把「↑」读成「上箭头」，与 aria-label 重复且无意义）", () => {
    store.state = { stats: null };
    const { container } = render(<SessionStatsTitlebar />);
    for (const sym of ["↑", "↓", "⚡", "Σ"]) {
      const glyph = [...container.querySelectorAll<HTMLElement>("span[aria-hidden='true']")]
        .find((el) => el.textContent === sym);
      expect(glyph, `${sym} 的字形 span 未标 aria-hidden`).toBeTruthy();
    }
  });

  it("有真实数据时可访问名带上数值（不是只有静态标题）", () => {
    store.state = { stats: { tokens: { input: 5, cacheRead: 10000, cacheWrite: 2000, output: 3000, total: 15005 }, tps: 42.5 } };
    const { container } = render(<SessionStatsTitlebar />);
    expect(itemOf(container, "↑")!.getAttribute("aria-label")).toContain("12.0k");
    expect(itemOf(container, "Σ")!.getAttribute("aria-label")).toContain("15.0k");
    expect(itemOf(container, "⚡")!.getAttribute("aria-label")).toContain("42.5");
  });
});
