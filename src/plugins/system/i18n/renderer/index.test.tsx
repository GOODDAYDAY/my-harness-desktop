// @vitest-environment jsdom
// LanguageSettings 的 DOM 断言 —— 钉住四处(该插件此前零 e2e、零单测):
//   ① `ctx.i18n.list()` 返回的语言被渲染
//   ② 当前语言被标为 active(`currentLocale === l.id`)
//   ③ 点某项 → `setCurrentLocale(id)`
//   ④ **`ctx.i18n.list` 缺失时不崩**(代码是 `list?.()` —— 能力面可选)
//   ⑤ **`refreshSignal` 变化会重新拉取语言清单**(掉出 effect 依赖 → 设置页永不刷新)
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  current: "zh-CN",
  setCalls: [] as string[],
  listCalls: 0,
  listImpl: (async () => [{ id: "zh-CN", name: "简体中文" }, { id: "en", name: "English" }]) as null | (() => Promise<{ id: string; name: string }[]>),
  hasList: true,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
// ⚠ ctx 必须是**稳定引用**:组件 effect 的依赖是 `ctx.i18n`,若每次渲染返回新对象,
// effect 会每次重跑 → setLocales → 重渲染 → **无限循环**(实测:整轮 60s 超时)。
// 真实的 usePluginContext 是 memo 的;mock 也必须复现这一点。
const stableCtx = vi.hoisted(() => ({ i18n: { list: async () => [] as { id: string; name: string }[] } }));
vi.mock("@my-harness-desktop/react", () => ({
  useUiStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ currentLocale: h.current, setCurrentLocale: (id: string) => { h.setCalls.push(id); } }),
  usePluginContext: () => (h.hasList ? stableCtx : { i18n: {} }),
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section><h3>{title}</h3>{children}</section>
  ),
  // 把 active 透成属性,便于断言"当前语言被标出"
  ListItem: ({ children, active, onClick }: { children: React.ReactNode; active?: boolean; onClick?: () => void }) => (
    <button type="button" data-active={String(active === true)} onClick={onClick}>{children}</button>
  ),
}));

import { LanguageSettings } from "./index";

const props = (refreshSignal = 0) => ({ refreshSignal, config: null, onChange: () => {} });
const activeOf = (name: string): string =>
  screen.getByText(name).closest("button")!.getAttribute("data-active")!;

beforeEach(() => {
  h.current = "zh-CN"; h.setCalls = []; h.listCalls = 0; h.hasList = true;
  stableCtx.i18n.list = async () => { h.listCalls += 1; return h.listImpl!(); };
});

describe("LanguageSettings(语言设置页)", () => {
  it("渲染 ctx.i18n.list() 返回的语言,并标出当前语言", async () => {
    render(<LanguageSettings {...props()} />);
    expect(await screen.findByText("简体中文")).toBeInTheDocument();
    expect(screen.getByText("English")).toBeInTheDocument();
    expect(activeOf("简体中文"), "当前语言没有被标为 active").toBe("true");
    expect(activeOf("English")).toBe("false");
  });

  it("点某项 → setCurrentLocale(该项 id)", async () => {
    render(<LanguageSettings {...props()} />);
    fireEvent.click(await screen.findByText("English"));
    expect(h.setCalls).toEqual(["en"]);
  });

  it("**ctx.i18n.list 缺失时不崩**(能力面可选:list?.())", () => {
    h.hasList = false;
    expect(() => render(<LanguageSettings {...props()} />)).not.toThrow();
    expect(screen.getByText("settings.language")).toBeInTheDocument();
  });

  it("**refreshSignal 变化会重新拉取清单**", async () => {
    const { rerender } = render(<LanguageSettings {...props(0)} />);
    await waitFor(() => expect(h.listCalls).toBe(1));

    rerender(<LanguageSettings {...props(1)} />);
    await waitFor(() => expect(h.listCalls, "refreshSignal 变了却没重新拉取").toBe(2));
  });
});
