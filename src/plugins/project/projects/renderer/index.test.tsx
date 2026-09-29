// @vitest-environment jsdom
// ProjectsSection 的 DOM 断言 —— project/projects 插件此前**零渲染层测试**。
// 三条契约全部源自该文件注释里**自述的根因**(即都曾是真 bug),且都是**静默型**:
//   ① 切项目**必须委托** store 的 switchCwd —— 注释:
//      「此前插件自己 startNewChat 是**无条件新会话的根因**」。故给 clearSessionContext 放探针:
//      单纯切项目时**不得**被调用(那是壳动作内部该做的事)。
//   ② 摘掉**当前**项目必须清 cwd + 会话上下文 —— 注释:
//      「否则列表删光了 cwd 还残留(lastCwd 随 prefs 持久化,重启又拉回来,**"删不干净"的根因**)」。
//      反向也钉:摘**非当前**项目**不得**清(否则切走别人把当前会话也清了)。
//   ③ 点项目**只切换、不重排** —— 注释:「顺序语义:点项目只切换、不重排(置顶只由"新增/拖拽"触发)」。
//
// 读取方式:按 title(绝对路径,fixture 自控,无基名歧义)定位行;断言用 store 探针而非 DOM 文本。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  cwds: [] as string[],
  currentCwd: "",
  switchCalls: [] as string[],
  setCwdCalls: [] as string[],
  clearCalls: 0,
  configSets: [] as unknown[][],
}));
const ctx = vi.hoisted(() => ({
  o: {} as Record<string, unknown>,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ctx.o,
  useUiStore: () => ({
    currentCwd: h.currentCwd,
    setCurrentCwd: (v: string) => { h.setCwdCalls.push(v); },
    clearSessionContext: () => { h.clearCalls += 1; },
  }),
  // store 动作:注释要求切项目**委托**它
  useSessionStore: Object.assign(() => ({}), {
    getState: () => ({ switchCwd: async (d: string) => { h.switchCalls.push(d); } }),
  }),
  Section: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

import { ProjectsSection } from "./index";

const row = (dir: string): HTMLElement => document.querySelector(`[title="${dir}"]`) as HTMLElement;
beforeEach(() => {
  h.cwds = ["/w/alpha", "/w/beta"]; h.currentCwd = "/w/alpha";
  h.switchCalls = []; h.setCwdCalls = []; h.clearCalls = 0; h.configSets = [];
  ctx.o = {
    config: {
      get: async (k: string) => (k === "recentCwds" ? h.cwds : k === "sectionCollapsed" ? false : undefined),
      set: async (...a: unknown[]) => { h.configSets.push(a); },
    },
  };
});

describe("ProjectsSection(左栏项目组)", () => {
  it("列出 recentCwds 的每一项(按绝对路径锚定)", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/alpha")).toBeTruthy());
    expect(row("/w/beta")).toBeTruthy();
  });

  it("① 点项目 → **委托** store.switchCwd(dir);不自作主张清会话上下文", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/beta")).toBeTruthy());
    fireEvent.click(row("/w/beta"));
    await waitFor(() => expect(h.switchCalls).toEqual(["/w/beta"]));
    expect(h.clearCalls, "切项目时插件自己清了会话上下文(应交给壳动作内部决定)").toBe(0);
  });

  // 移除控件的锚（r156 更新）：现在用**稳定锚点** `[data-project-remove]`，不再按标签结构猜。
  //   此前它是"行内唯一带 title 的 **span**、且悬停后才渲染"，所以本测试只能写
  //   `row(dir).querySelector("span[title]")` 并先 mouseEnter —— 那是**脆弱探针**：
  //   元素换标签（r156 把 span 改成真 button）测试就红，而产品行为其实变好了。
  //   r156 修复后：按钮**常驻 DOM**（可见性由 hovered||focused 驱动），
  //   所以不再需要 mouseEnter，而且键盘用户也能 Tab 到它（此前既 hover 门控、又是 span 不可聚焦）。
  const removeControl = (dir: string): HTMLElement | null =>
    row(dir).querySelector<HTMLElement>("[data-project-remove]");

  it("② 摘掉**当前**项目 → 清 cwd + 会话上下文(否则'删不干净')", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/alpha")).toBeTruthy());
    const ctl = removeControl("/w/alpha");
    // r156：不需要 hover 就该在 DOM 里（此前是条件渲染，键盘用户够不着）
    expect(ctl, "移除控件应常驻 DOM（r156 修 hover 门控）").not.toBeNull();
    expect(ctl!.style.opacity, "未 hover/未聚焦时视觉隐藏但仍可聚焦").toBe("0");
    expect(ctl!.tagName, "必须是真 button（此前是 span ⇒ 不可聚焦、Enter/Space 无效）").toBe("BUTTON");
    fireEvent.click(ctl!);
    await waitFor(() => expect(h.clearCalls, "摘掉当前项目没有清会话上下文('删不干净'的根因)").toBe(1));
    expect(h.setCwdCalls, "摘掉当前项目没有把 cwd 置空").toContain("");
  });

  it("②b 摘掉**非当前**项目 → **不得**清当前会话上下文", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/beta")).toBeTruthy());
    fireEvent.click(removeControl("/w/beta")!);   // r156：常驻 DOM，不需先 hover
    await waitFor(() => expect(h.configSets.length).toBeGreaterThan(0));
    expect(h.clearCalls, "摘掉别的项目却把当前会话清掉了").toBe(0);
  });

  it("③ 点项目**只切换、不重排**(落盘顺序不变)", async () => {
    render(<ProjectsSection />);
    await waitFor(() => expect(row("/w/beta")).toBeTruthy());
    fireEvent.click(row("/w/beta"));
    await waitFor(() => expect(h.switchCalls).toEqual(["/w/beta"]));
    const orderWrite = h.configSets.find((a) => a[0] === "recentCwds");
    expect(orderWrite, "点项目竟写回了 recentCwds(会重排)").toBeUndefined();
  });
});
