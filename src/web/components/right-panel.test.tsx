// @vitest-environment jsdom
// 右面板堆叠 Tab 的分隔线守卫(§5.6 第 2 级)——把"风格不许把拖拽热区一起关掉"钉在右面板上。
//
// 根因实弹:手柄自己的 display 用了 var(--sidepanel-divider-display),而 card/minimal/glass
// 三个风格把它设成 none —— 于是这三种风格下堆叠 Tab 的高度比彻底调不了(面板只靠这条手柄
// 调高度:Tab 开关只是增删板块,布局引擎那条手柄调的是整列宽度)。修法与左栏一致:
// 热区恒 display:flex(8px、row-resize),只有内线的显隐走 --sidepanel-divider-visual-display。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import * as React from "react";

/** 壳侧只读的 UI store 面(选择器口径与真实 store 一致)。 */
const uiState = {
  sidepanelStyle: "default",
  activeSidePanelTabs: ["tree", "review"],
  sidePanelOrder: [] as string[],
  pluginsNonce: 0,
};

vi.mock("@my-harness-desktop/react", () => ({
  useUiStore: (sel: (s: typeof uiState) => unknown) => sel(uiState),
  // 组件注册中心:返回一个渲染固定文本的桩组件(本测试只关心手柄)
  getSidePanelComponent: () => () => "stub",
  PluginIcon: () => null,
  PluginIdContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
  useGroupHidden: () => false,
  DEFAULT_GROUP_IDS: { LEFT: "left", MAIN: "main", RIGHT: "right" },
  eventBus: { tap: () => () => {}, on: () => () => {}, emitSystem: () => {} },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { RightPanelContent } from "./right-panel";

const SLOT_ITEMS = [
  { id: "tree", label: "会话树", icon: "git-fork", component: "SessionTreeTab", pluginId: "session-tree" },
  { id: "review", label: "Git Review", icon: "git-branch", component: "GitWorkspaceTab", pluginId: "git-review" },
];

beforeEach(() => {
  uiState.sidepanelStyle = "default";
  uiState.activeSidePanelTabs = ["tree", "review"];
  (window as unknown as { kernel: unknown }).kernel = {
    slots: { sidePanel: async () => SLOT_ITEMS },
    prefs: { get: async () => undefined, set: async () => {} },
  };
});

afterEach(() => cleanup());

/** 渲染右面板内容体,等贡献清单从 IPC 落到 DOM(异步 useEffect,不赌固定 sleep)。 */
async function renderPanel(): Promise<HTMLElement> {
  const { container } = render(<RightPanelContent />);
  await waitFor(() => expect(container.querySelectorAll('[data-panel=""]').length).toBeGreaterThan(0));
  return container;
}

describe("右面板:活跃 Tab 数 → 手柄数", () => {
  it("两个活跃 Tab → 两个 Panel + 一条可拖拽分隔线", async () => {
    const container = await renderPanel();
    expect(container.querySelectorAll('[data-panel=""]').length).toBe(2);
    expect(container.querySelectorAll('[role="separator"]').length).toBe(1);
  });

  it("只有一个活跃 Tab → 没有分隔线(库只在相邻面板之间渲染手柄)", async () => {
    uiState.activeSidePanelTabs = ["tree"];
    const container = await renderPanel();
    expect(container.querySelectorAll('[data-panel=""]').length).toBe(1);
    expect(container.querySelectorAll('[role="separator"]').length).toBe(0);
  });
});

describe("分隔线热区与视觉解耦(风格不许把热区一起干掉)", () => {
  for (const style of ["default", "card", "minimal", "glass", "outline"]) {
    it(`sidepanelStyle=${style}:热区恒在(row-resize/8px),内线才走 --sidepanel-divider-visual-display`, async () => {
      uiState.sidepanelStyle = style;
      const container = await renderPanel();
      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      expect(handle).toBeTruthy();
      expect(handle.style.display).toBe("flex");
      expect(handle.style.height).toBe("8px");
      expect(handle.style.cursor).toBe("row-resize");
      expect(handle.style.display).not.toContain("--sidepanel-divider");
      const line = handle.firstElementChild as HTMLElement;
      expect(line.style.display).toBe("var(--sidepanel-divider-visual-display)");
      cleanup();
    });
  }
});
