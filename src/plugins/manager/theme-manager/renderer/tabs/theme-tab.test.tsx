// @vitest-environment jsdom
// ThemeTab 的 DOM 断言 —— theme-manager 插件目前**零测试**,从它的主题网格起步。
//   ① ctx.themes.list() 的主题被渲染成卡片
//   ② 当前主题被标为 active(currentThemeId === opt.id)
//   ③ 点卡片 → setCurrentThemeId(opt.id)
//   ④ **label 的 i18n-key 启发式**:名字含 "." → 当 key 翻(以原名为兜底);不含 → 原样显示
//      (可静默坏:改成永远 t() 或永远原样,界面上都"看着正常")
//
// ⚠ 预防性应用 skills §10.5 第 14 条:该组件 effect 依赖 **`ctx` 对象本身**,
//   若 mock 每次渲染返回**新对象** → 依赖每次变化 → setState → 重渲染 → **无限循环**
//   (第 164 轮在 i18n 插件上真踩过,整轮 60s 超时)。所以 ctx 必须是**模块级稳定引用**。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  listCalls: 0,
  themes: [] as { id: string; name: string }[],
  current: "a",
  selects: [] as string[],
  tCalls: [] as string[],
}));
// 稳定 ctx(见上方注释):只改它的字段,不换对象
const stableCtx = vi.hoisted(() => ({ themes: { list: async () => [] as { id: string; name: string }[] } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => { h.tCalls.push(k); return "T(" + k + ")"; } }),
}));
vi.mock("@my-harness-desktop/react", () => ({
  useUiStore: () => ({ currentThemeId: h.current, setCurrentThemeId: (id: string) => { h.selects.push(id); } }),
  usePluginContext: () => stableCtx,
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section><h3>{title}</h3>{children}</section>
  ),
}));
vi.mock("../theme-preview", () => ({
  ThemePreviewCard: ({ themeId, label, active, onSelect }: { themeId: string; label: string; active: boolean; onSelect: () => void }) => (
    <button type="button" data-theme={themeId} data-active={String(active)} onClick={onSelect}>{label}</button>
  ),
}));

import { ThemeTab } from "./theme-tab";

const card = (id: string): HTMLElement => document.querySelector(`[data-theme="${id}"]`) as HTMLElement;

beforeEach(() => {
  h.listCalls = 0; h.current = "a"; h.selects = []; h.tCalls = [];
  h.themes = [{ id: "a", name: "theme.solarized" }, { id: "b", name: "PlainTheme" }];
  stableCtx.themes.list = async () => { h.listCalls += 1; return h.themes; };
});

describe("ThemeTab(主题网格)", () => {
  it("① list() 的主题被渲染成卡片", async () => {
    render(<ThemeTab />);
    await waitFor(() => expect(card("a")).toBeTruthy());
    expect(card("b")).toBeTruthy();
    expect(h.listCalls).toBe(1);
  });

  it("② 当前主题标 active,其余不标", async () => {
    render(<ThemeTab />);
    await waitFor(() => expect(card("a")).toBeTruthy());
    expect(card("a").getAttribute("data-active"), "当前主题没被标出").toBe("true");
    expect(card("b").getAttribute("data-active")).toBe("false");
  });

  it("③ 点卡片 → setCurrentThemeId(该 id)", async () => {
    render(<ThemeTab />);
    await waitFor(() => expect(card("b")).toBeTruthy());
    fireEvent.click(card("b"));
    expect(h.selects).toEqual(["b"]);
  });

  it("④ label 启发式:含 '.' 的名字当 key 翻;不含的原样显示", async () => {
    render(<ThemeTab />);
    await waitFor(() => expect(card("a")).toBeTruthy());
    expect(card("a").textContent, "含点的名字没有走 i18n key").toBe("T(theme.solarized)");
    expect(h.tCalls, "不含点的名字不该被当 key").not.toContain("PlainTheme");
    expect(card("b").textContent, "不含点的名字没有原样显示").toBe("PlainTheme");
  });
});
