// @vitest-environment jsdom
// SidepanelTab 的 DOM 断言 —— 与 sidebar-tab 结构**逐字同形**(同契约、不同 store 字段)。
//
// 重点在同族对比(skills §10.4.1):**两个 tab 必须各写各的 store 字段**。
// 从 sidebar 复制粘贴忘改 → sidepanel 页会去写 sidebar 的设置 ✗ ——
// **不报错、不崩,只是两个面板抢同一个值**(调一边另一边跟着变,或调了没反应)。
// 所以本文件里 sidebar 的 setter **也放了探针**:它一旦被调用就是接线错了。
//
// 另两条与 sidebar 同源的静默可坏点(一并钉):Number() 转换、指针按下/抬起成对。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({
  scale: 1,
  style: "sp1",
  sideScaleCalls: [] as unknown[],
  sideStyleCalls: [] as string[],
  sideDragCalls: [] as boolean[],
  // 探针:sidebar 的 setter **不该**被本 tab 调用
  barScaleCalls: [] as unknown[],
  barStyleCalls: [] as string[],
}));

const store = (): Record<string, unknown> => ({
  sidepanelStyle: h.style,
  setSidepanelStyle: (id: string) => { h.sideStyleCalls.push(id); },
  sidepanelFontScale: h.scale,
  setSidepanelFontScale: (v: unknown) => { h.sideScaleCalls.push(v); },
  setFontPreviewDragging: (v: boolean) => { h.sideDragCalls.push(v); },
  // sidebar 侧(仅作探针)
  setSidebarFontScale: (v: unknown) => { h.barScaleCalls.push(v); },
  setSidebarStyle: (id: string) => { h.barStyleCalls.push(id); },
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  useUiStore: () => store(),
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section data-section={title}>{children}</section>
  ),
  SIDEPANEL_STYLE_PRESETS: [{ id: "sp1" }, { id: "sp2" }],
  AREA_FONT_SCALE_MIN: 0.5,
  AREA_FONT_SCALE_MAX: 2,
}));
vi.mock("../sidepanel-style-preview", () => ({
  SidepanelStylePreviewCard: ({ preset, active, onSelect }: { preset: { id: string }; active: boolean; onSelect: () => void }) => (
    <button type="button" data-preset={preset.id} data-active={String(active)} onClick={onSelect} />
  ),
}));

import { SidepanelTab } from "./sidepanel-tab";

const range = (): HTMLInputElement => document.querySelector('input[type="range"]') as HTMLInputElement;
const card = (id: string): HTMLElement => document.querySelector(`[data-preset="${id}"]`) as HTMLElement;

beforeEach(() => {
  h.scale = 1; h.style = "sp1";
  h.sideScaleCalls = []; h.sideStyleCalls = []; h.sideDragCalls = [];
  h.barScaleCalls = []; h.barStyleCalls = [];
});

describe("SidepanelTab(右面板字号 + 样式预设)", () => {
  it("滑杆接线:常量 min/max/step + store 当前值", () => {
    render(<SidepanelTab />);
    expect(range().min).toBe("0.5");
    expect(range().max).toBe("2");
    expect(range().step).toBe("0.05");
    expect(range().value).toBe("1");
  });

  it("★ 用**自己的** store 字段,不碰 sidebar 的(复制粘贴忘改会抢同一设置)", () => {
    render(<SidepanelTab />);
    fireEvent.change(range(), { target: { value: "1.5" } });
    expect(h.sideScaleCalls, "没有写入 sidepanel 的字号").toEqual([1.5]);
    expect(typeof h.sideScaleCalls[0], "入 store 的不是数字").toBe("number");
    expect(h.barScaleCalls, "写入到了 **sidebar** 的字号(两个面板抢同一设置)").toEqual([]);

    fireEvent.click(card("sp2"));
    expect(h.sideStyleCalls).toEqual(["sp2"]);
    expect(h.barStyleCalls, "写入到了 **sidebar** 的样式").toEqual([]);
  });

  it("显示值 toFixed(2)", () => {
    render(<SidepanelTab />);
    expect(document.body.textContent, "没有按两位小数显示当前字号").toContain("1.00");
  });

  it("指针按下→抬起成对置位(只开不关会卡住拖拽态)", () => {
    render(<SidepanelTab />);
    fireEvent.pointerDown(range());
    fireEvent.pointerUp(range());
    expect(h.sideDragCalls, "没有成对设置拖拽预览态").toEqual([true, false]);
  });

  it("预设:当前样式标 active,点击 → setSidepanelStyle(id)", () => {
    render(<SidepanelTab />);
    expect(card("sp1").getAttribute("data-active")).toBe("true");
    expect(card("sp2").getAttribute("data-active")).toBe("false");
  });
});
