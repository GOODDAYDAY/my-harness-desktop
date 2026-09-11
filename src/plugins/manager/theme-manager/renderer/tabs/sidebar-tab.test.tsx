// @vitest-environment jsdom
// SidebarTab 的 DOM 断言 —— theme-manager 第二个 tab(与 theme-tab 同族)。
// 两条**静默可坏**契约是重点:
//   ① 滑杆 onChange 必须 **Number() 转换**后入 store —— 直接传 e.target.value 是**字符串**,
//      不报错、不崩,但 store 里从此多了个字符串值(下游 toFixed/比较会陆续出怪)。
//   ② **指针按下/抬起必须成对** —— 少了 onPointerUp,拖拽预览态会**永远卡住** ✗
//      (这一类"只开不关"的泄漏,界面上一眼看不出来,要拖过才发现)。
// 另:滑杆的 min/max/step/value 与显示值(toFixed(2))、预设卡的 active/onSelect。
//
// 读取方式:断言 DOM 属性与 store 实收值(不用 getByText 断数字 —— 无归一化问题但仍以精确相等为准)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({
  scale: 1,
  style: "s1",
  scaleCalls: [] as unknown[],
  styleCalls: [] as string[],
  dragCalls: [] as boolean[],
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  useUiStore: () => ({
    sidebarStyle: h.style,
    setSidebarStyle: (id: string) => { h.styleCalls.push(id); },
    sidebarFontScale: h.scale,
    setSidebarFontScale: (v: unknown) => { h.scaleCalls.push(v); },
    setFontPreviewDragging: (v: boolean) => { h.dragCalls.push(v); },
  }),
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section data-section={title}>{children}</section>
  ),
  // 常量 mock 成已知值:断言的是"接线用了常量",不是常量的具体数值
  SIDEBAR_STYLE_PRESETS: [{ id: "s1", name: "S1" }, { id: "s2", name: "S2" }],
  AREA_FONT_SCALE_MIN: 0.5,
  AREA_FONT_SCALE_MAX: 2,
}));
vi.mock("../sidebar-style-preview", () => ({
  SidebarStylePreviewCard: ({ preset, active, onSelect }: { preset: { id: string }; active: boolean; onSelect: () => void }) => (
    <button type="button" data-preset={preset.id} data-active={String(active)} onClick={onSelect} />
  ),
}));

import { SidebarTab } from "./sidebar-tab";

const range = (): HTMLInputElement => document.querySelector('input[type="range"]') as HTMLInputElement;
const card = (id: string): HTMLElement => document.querySelector(`[data-preset="${id}"]`) as HTMLElement;

beforeEach(() => { h.scale = 1; h.style = "s1"; h.scaleCalls = []; h.styleCalls = []; h.dragCalls = []; });

describe("SidebarTab(字号滑杆 + 侧栏样式预设)", () => {
  it("滑杆的 min/max/step/value 接自常量与 store", () => {
    render(<SidebarTab />);
    expect(range().min).toBe("0.5");
    expect(range().max).toBe("2");
    expect(range().step).toBe("0.05");
    expect(range().value).toBe("1");
  });

  it("① onChange **换算成数字**再入 store(传字符串会静默污染 store)", () => {
    render(<SidebarTab />);
    fireEvent.change(range(), { target: { value: "1.25" } });
    expect(h.scaleCalls.length).toBe(1);
    expect(typeof h.scaleCalls[0], "入 store 的不是数字(字符串会静默污染)").toBe("number");
    expect(h.scaleCalls[0]).toBe(1.25);
  });

  it("显示值按 toFixed(2) 呈现(当前值 1 → 「1.00」)", () => {
    render(<SidebarTab />);
    expect(document.body.textContent, "没有按两位小数显示当前字号").toContain("1.00");
  });

  it("② 指针按下→抬起**成对**置位(只开不关会让拖拽态永远卡住)", () => {
    render(<SidebarTab />);
    fireEvent.pointerDown(range());
    fireEvent.pointerUp(range());
    expect(h.dragCalls, "没有成对设置拖拽预览态").toEqual([true, false]);
  });

  it("预设卡:当前样式标 active,另一个不标", () => {
    render(<SidebarTab />);
    expect(card("s1").getAttribute("data-active")).toBe("true");
    expect(card("s2").getAttribute("data-active")).toBe("false");
  });

  it("点预设卡 → setSidebarStyle(该 id)", () => {
    render(<SidebarTab />);
    fireEvent.click(card("s2"));
    expect(h.styleCalls).toEqual(["s2"]);
  });
});
