// @vitest-environment jsdom
// Sidebar 槽壳的 DOM 交互守卫(§5.6 第 2 级)——把两条"看着全对但拖不动"的坑钉住:
//
//  ① 组数 → 手柄数:同 group 的贡献项只占一个 Panel(0 条手柄),不同 group 才出现
//     可拖拽分隔线。根因实弹:projects/sessions-list/sub-agent 三个贡献项同 group,
//     左栏只有 1 个 Panel → 项目区与会话区之间怎么拖都不动。
//  ② 手柄热区不随侧栏风格消失:风格差异只作用于"内线"(--sidebar-divider-visual-display),
//     手柄本身必须恒为可命中——旧版两者共用一个 token,card/minimal/glass 把 display
//     设成 none 时连热区一起干掉,组分开也依然拖不动。
//  ③ manifest 的 defaultSize 提示要真的走到库里(Panel 的 flexGrow/data-panel-size)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import * as React from "react";

/** 壳侧只读的 UI store 面(选择器口径与真实 store 一致)。 */
const uiState = { sidebarStyle: "default", pluginsNonce: 0, setActiveView: (): void => {} };
let sidebarItems: unknown[] = [];

vi.mock("@my-harness-desktop/react", () => ({
  useUiStore: (sel: (s: typeof uiState) => unknown) => sel(uiState),
  // 组件注册中心:返回一个渲染固定文本的桩组件(本测试只关心槽壳的分组/手柄行为)
  getSidebarComponent: () => () => "stub",
  PluginIdContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { Sidebar, collapsedSizePercent } from "./sidebar";

const contribution = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "x",
  title: "X",
  component: "XSection",
  pluginId: "x-plugin",
  ...over,
});

/** 渲染后等到槽位清单从 IPC 落到 DOM(异步 useEffect,不赌固定 sleep)。 */
async function renderSidebar(): Promise<HTMLElement> {
  const { container } = render(<Sidebar />);
  await waitFor(() => expect(container.querySelectorAll('[data-panel=""]').length).toBeGreaterThan(0));
  return container;
}

beforeEach(() => {
  sidebarItems = [];
  uiState.sidebarStyle = "default";
  (window as unknown as { kernel: unknown }).kernel = {
    slots: { sidebar: async () => sidebarItems },
  };
});

afterEach(() => cleanup());

describe("Sidebar 分组 → 面板 / 手柄", () => {
  it("不同 group 的贡献项各占一个 Panel,并渲染一条可拖拽分隔线", async () => {
    sidebarItems = [
      contribution({ id: "projects", group: "projects", order: 5, defaultSize: 25 }),
      contribution({ id: "sessions", pluginId: "sessions-list", group: "main", order: 10 }),
    ];
    const container = await renderSidebar();
    expect(container.querySelectorAll('[data-panel=""]').length).toBe(2);
    expect(container.querySelectorAll('[role="separator"]').length).toBe(1);
  });

  it("同 group 的贡献项挤在一个 Panel(0 条手柄)——正是「拖不动」的机制本身", async () => {
    sidebarItems = [
      contribution({ id: "projects", group: "main", order: 5 }),
      contribution({ id: "sessions", pluginId: "sessions-list", group: "main", order: 10 }),
      contribution({ id: "sub-agents", pluginId: "sub-agent", group: "main", order: 20 }),
    ];
    const container = await renderSidebar();
    expect(container.querySelectorAll('[data-panel=""]').length).toBe(1);
    expect(container.querySelectorAll('[role="separator"]').length).toBe(0);
  });

  it("defaultSize 提示经契约走到了库:首个 Panel 的 flexGrow = 25(未声明者不吃这个值)", async () => {
    sidebarItems = [
      contribution({ id: "projects", group: "projects", order: 5, defaultSize: 25 }),
      contribution({ id: "sessions", pluginId: "sessions-list", group: "main", order: 10 }),
    ];
    const container = await renderSidebar();
    // jsdom 无排版:库只在"真实测量后"才把剩余份额算给未声明的 Panel,故这里只能断言
    // 「提示值确实传进了库」(data-panel-size = flexGrow),25/75 的实际比例与拖拽改比例
    // 由 e2e(真实产物 + CDP)覆盖。断言 25 已经足以证明 manifest → registry → 壳 → 库 的链路通。
    await waitFor(() => {
      const sizes = [...container.querySelectorAll('[data-panel=""]')].map((p) => p.getAttribute("data-panel-size"));
      expect(sizes[0]).toBe("25.0");
      expect(sizes[1]).not.toBe("25.0");
    });
  });
});

describe("分隔线热区与视觉解耦(风格不许把热区一起干掉)", () => {
  for (const style of ["default", "card", "minimal", "glass", "outline"]) {
    it(`sidebarStyle=${style}:手柄热区恒在(row-resize),内线才走 --sidebar-divider-visual-display`, async () => {
      uiState.sidebarStyle = style;
      sidebarItems = [
        contribution({ id: "projects", group: "projects", order: 5 }),
        contribution({ id: "sessions", pluginId: "sessions-list", group: "main", order: 10 }),
      ];
      const container = await renderSidebar();
      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      expect(handle).toBeTruthy();
      // 热区:cursor 与 display 都不依赖风格 token(风格只管线)
      expect(handle.style.display).toBe("flex");
      expect(handle.style.cursor).toBe("row-resize");
      expect(handle.style.display).not.toContain("--sidebar-divider");
      const line = handle.firstElementChild as HTMLElement;
      expect(line.style.display).toBe("var(--sidebar-divider-visual-display)");
      cleanup();
    });
  }
});

// 折叠联动:整组收起 → 该组 Panel 塌到"折叠头 + 组内留白",腾出的高度让给后面的组。
// 像素行为(面板真的变小、会话区真的跟上来)由 e2e 覆盖(jsdom 无排版,壳在 boxPx<=0 时
// 本就不动作);这里钉两件在 jsdom 里可判的事:① 百分比换算的纯函数;② 信号源——
// 框架 Section 必须挂出壳消费的两个声明式锚点,锚点丢了折叠联动就是静默失效。
describe("折叠联动:塌缩高度换算(纯函数)", () => {
  it("塌缩目标 = (折叠头 + 组内留白) / 容器高度,取一位小数", () => {
    // 30px 头 + 20px 留白 / 900px ≈ 5.6%
    expect(collapsedSizePercent(30, 20, 900, 10)).toBe(5.6);
  });

  it("下限 1%:头很矮/容器很高也不许塌成 0(0 会把展开入口一起收掉)", () => {
    expect(collapsedSizePercent(4, 0, 2000, 10)).toBe(1);
  });

  it("上限 minSize-1:头比 minSize 还高时也要小于 minSize,库才判得出'塌缩态'", () => {
    expect(collapsedSizePercent(200, 20, 300, 10)).toBe(9);
  });

  it("容器未测量(0)或没有折叠头(非 Section 组)→ 0,调用方据此不动作", () => {
    expect(collapsedSizePercent(30, 20, 0, 10)).toBe(0);
    expect(collapsedSizePercent(0, 20, 900, 10)).toBe(0);
  });
});
