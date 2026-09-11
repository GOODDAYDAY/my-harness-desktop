// @vitest-environment jsdom
// TimelineTab 的 DOM 断言 —— theme-manager 第 4 个(最后一个)tab,汇总前三个的全部契约,
// 并多一条**哨兵值**契约:
//   ★ "继承全局主题"用魔法字符串 `__inherit__` 表示 —— 拼错就永远不 active ✗,
//     且点下去会把**假主题 id** 写进 store ✗,而界面看不出异常。
// 同族串线(§10.4.1):本 tab 用 `setTimelineThemeId`;从 theme-tab 复制粘贴会写成
//   `setCurrentThemeId` ✗ —— 于是"时间线主题"改的实际是**全局主题**。故给前三个 tab 的
//   setter 都放了探针(被调用即接线错)。
// 另有与前两个 tab 同源的三条:Number() 转换、指针按下/抬起成对、label 的 i18n-key 启发式。
//
// ⚠ 预防性应用 §10.5 第 14 条:effect 依赖 `ctx` → ctx mock 必须是**模块级稳定引用**
//   (第 164 轮在 i18n 插件上因 mock 每次返回新对象把整轮跑成 60s 超时)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  theme: "t1",
  scale: 1,
  themes: [] as { id: string; name: string }[],
  themeCalls: [] as string[],
  scaleCalls: [] as unknown[],
  dragCalls: [] as boolean[],
  // 探针:其它 tab 的 setter 不该被本 tab 调用
  others: { sidebarScale: 0, sidepanelScale: 0, globalTheme: 0, sidebarStyle: 0 },
}));
const stableCtx = vi.hoisted(() => ({ themes: { list: async () => [] as { id: string; name: string }[] } }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => "T(" + k + ")" }) }));
vi.mock("@my-harness-desktop/react", () => ({
  useUiStore: () => ({
    timelineThemeId: h.theme,
    setTimelineThemeId: (id: string) => { h.themeCalls.push(id); },
    timelineFontScale: h.scale,
    setTimelineFontScale: (v: unknown) => { h.scaleCalls.push(v); },
    setFontPreviewDragging: (v: boolean) => { h.dragCalls.push(v); },
    setCurrentThemeId: () => { h.others.globalTheme += 1; },
    setSidebarFontScale: () => { h.others.sidebarScale += 1; },
    setSidepanelFontScale: () => { h.others.sidepanelScale += 1; },
    setSidebarStyle: () => { h.others.sidebarStyle += 1; },
  }),
  usePluginContext: () => stableCtx,
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section data-section={title}>{children}</section>
  ),
  ListItem: ({ children, active, onClick }: { children: React.ReactNode; active?: boolean; onClick?: () => void }) => (
    <button type="button" data-inherit="true" data-active={String(active === true)} onClick={onClick}>{children}</button>
  ),
  AREA_FONT_SCALE_MIN: 0.5,
  AREA_FONT_SCALE_MAX: 2,
}));
vi.mock("../theme-preview", () => ({
  ThemePreviewCard: ({ themeId, label, active, onSelect }: { themeId: string; label: string; active: boolean; onSelect: () => void }) => (
    <button type="button" data-theme={themeId} data-active={String(active)} onClick={onSelect}>{label}</button>
  ),
}));

import { TimelineTab } from "./timeline-tab";

const range = (): HTMLInputElement => document.querySelector('input[type="range"]') as HTMLInputElement;
const inherit = (): HTMLElement => document.querySelector('[data-inherit="true"]') as HTMLElement;
const card = (id: string): HTMLElement => document.querySelector(`[data-theme="${id}"]`) as HTMLElement;

beforeEach(() => {
  h.theme = "t1"; h.scale = 1; h.themeCalls = []; h.scaleCalls = []; h.dragCalls = [];
  h.others = { sidebarScale: 0, sidepanelScale: 0, globalTheme: 0, sidebarStyle: 0 };
  h.themes = [{ id: "t1", name: "theme.dark" }, { id: "t2", name: "Plain" }];
  stableCtx.themes.list = async () => h.themes;
});

describe("TimelineTab(时间线字号 + 主题,含「继承」哨兵)", () => {
  it("★ 「继承」项的哨兵值是 __inherit__:点它写入的正是这个值", async () => {
    render(<TimelineTab />);
    fireEvent.click(inherit());
    expect(h.themeCalls, "「继承」没有写入哨兵值 __inherit__(拼错会存进假主题 id)").toEqual(["__inherit__"]);
  });

  it("★ 当前值是真实主题 id 时,「继承」**不** active;等于哨兵时才 active", async () => {
    const { unmount } = render(<TimelineTab />);
    await waitFor(() => expect(card("t1")).toBeTruthy());
    expect(inherit().getAttribute("data-active"), "没在继承态却标了继承").toBe("false");
    unmount();

    h.theme = "__inherit__";
    render(<TimelineTab />);
    await waitFor(() => expect(card("t1")).toBeTruthy());
    expect(inherit().getAttribute("data-active"), "继承态没有标出").toBe("true");
  });

  it("★ 用**自己的** store 字段:不写全局主题,也不写左右面板的(none-shot 探针)", async () => {
    render(<TimelineTab />);
    fireEvent.change(range(), { target: { value: "1.5" } });
    fireEvent.click(inherit());
    expect(h.scaleCalls, "没有写入时间线自己的字号").toEqual([1.5]);
    expect(typeof h.scaleCalls[0], "入 store 的不是数字").toBe("number");
    expect(h.others, "写到了别的 tab 的字段(复制粘贴串线)").toEqual({ sidebarScale: 0, sidepanelScale: 0, globalTheme: 0, sidebarStyle: 0 });
  });

  it("滑杆接线:常量 min/max/step、store 当前值、显示 toFixed(2)", () => {
    render(<TimelineTab />);
    expect(range().min).toBe("0.5");
    expect(range().max).toBe("2");
    expect(range().step).toBe("0.05");
    expect(range().value).toBe("1");
    expect(document.body.textContent).toContain("1.00");
  });

  it("指针按下→抬起成对置位", () => {
    render(<TimelineTab />);
    fireEvent.pointerDown(range());
    fireEvent.pointerUp(range());
    expect(h.dragCalls).toEqual([true, false]);
  });

  it("主题卡:label 走同一套 i18n-key 启发式,active 对账,点选写自己的字段", async () => {
    render(<TimelineTab />);
    await waitFor(() => expect(card("t1")).toBeTruthy());
    expect(card("t1").textContent, "含点的名字没当 key").toBe("T(theme.dark)");
    expect(card("t2").textContent, "不含点的名字没原样显示").toBe("Plain");
    expect(card("t1").getAttribute("data-active")).toBe("true");
    expect(card("t2").getAttribute("data-active")).toBe("false");
    fireEvent.click(card("t2"));
    expect(h.themeCalls).toEqual(["t2"]);
  });
});
