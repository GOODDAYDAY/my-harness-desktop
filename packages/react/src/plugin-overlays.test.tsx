// @vitest-environment jsdom
// PluginOverlays 的隔离性与 pluginId 注入断言（r255；消化发布面零测试引用清单里的 PluginOverlays）。
//
// ## 钉的性质（都来自组件自己的注释与结构）
//
// ① 没有已加载插件 / 插件没贡献 overlay ⇒ 什么都不渲染（不该多出空节点）；
// ② **每个 overlay 独立 ErrorBoundary**：单个插件的悬浮层崩溃**只摘除自己**、
//    不拖垮其它 overlay、也不拖垮主树（注释明写"共享根级边界"是不够的）；
// ③ 每个 overlay 被自己的 PluginIdContext 包住 ⇒ 组件里能拿到**自己的** pluginId
//    （这是插件侧 ctx 绑定 API 的前提；串号会让 A 插件写到 B 插件的配置里）；
// ④ pluginsNonce 变化 ⇒ 重新收集（useMemo 的依赖是 nonce，不重算就会漏掉新加载的插件）。
//
// ⚠ mock 边界：只 mock ./plugin-modules 的三个读口（getLoadedPluginIds / getPluginOverlay /
//   asReactComponent）——它们是"插件模块注册表"，属协作者；ErrorBoundary / PluginIdContext /
//   useUiStore 都用真的（被测性质正是边界与上下文注入，mock 掉就等于什么都没测，r163 的教训）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useContext } from "react";
import { PluginOverlays } from "./plugin-overlays";
import { PluginIdContext } from "./plugin-id-context";
import { getLoadedPluginIds, getPluginOverlay, asReactComponent } from "./plugin-modules";
import { useUiStore } from "../../../src/web/stores/ui-store";

vi.mock("./plugin-modules", () => ({
  getLoadedPluginIds: vi.fn(() => [] as string[]),
  getPluginOverlay: vi.fn(() => null),
  asReactComponent: vi.fn((x: unknown) => x),
}));

const mockIds = getLoadedPluginIds as unknown as ReturnType<typeof vi.fn>;
const mockOverlay = getPluginOverlay as unknown as ReturnType<typeof vi.fn>;
const mockAs = asReactComponent as unknown as ReturnType<typeof vi.fn>;

function Probe({ label }: { label: string }): React.ReactNode {
  const id = useContext(PluginIdContext);
  return <div data-probe={label}>id={String(id)}</div>;
}
// ⚠ r255 实踩：Probe 需要 label prop；把它当**无参组件**直接交给 overlay 时
//   label 是 undefined ⇒ React 省略 data-probe 属性 ⇒ querySelectorAll 查不到（夹具错，不是产品错）。
//   需要"无参 overlay 组件"时用这个（label 固定），需要区分多个时用上面的 Probe。
const ProbePlain = (): React.ReactNode => {
  const id = useContext(PluginIdContext);
  return <div data-probe="plain">id={String(id)}</div>;
};

beforeEach(() => {
  mockIds.mockReset(); mockOverlay.mockReset(); mockAs.mockReset();
  mockAs.mockImplementation((x: unknown) => x);
  mockIds.mockReturnValue([]);
  mockOverlay.mockReturnValue(null);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("PluginOverlays：每个 overlay 独立边界 + 自己的 pluginId", () => {
  it("① 没有插件 / 插件没贡献 overlay ⇒ 什么都不渲染", () => {
    mockIds.mockReturnValue(["p1"]);
    mockOverlay.mockReturnValue(null);           // 有插件但没贡献 overlay
    const { container } = render(<PluginOverlays />);
    expect(container.textContent, "不该渲染任何 overlay 内容").toBe("");
  });

  it("② 一个 overlay 抛错 ⇒ 只有它被摘除，其它 overlay 仍在（独立边界）", () => {
    const Boom = (): React.ReactNode => { throw new Error("overlay 崩了"); };
    mockIds.mockReturnValue(["bad", "good"]);
    mockOverlay.mockImplementation((id: string) => (id === "bad" ? Boom : () => <Probe label="good" />));
    // ErrorBoundary 会 console.error；这里不让它污染断言输出
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PluginOverlays />);
    expect(screen.queryByTestId?.("x")).toBeNull();
    expect(document.querySelector('[data-probe="good"]'),
      "崩溃的 overlay 不该拖垮同批的其它 overlay（注释：单个插件崩溃只摘除自己）").not.toBeNull();
    expect(document.body.textContent).not.toContain("overlay 崩了");
  });

  it("③ 每个 overlay 拿到**自己的** pluginId（串号会让 A 写到 B 的配置里）", () => {
    mockIds.mockReturnValue(["alpha", "beta"]);
    mockOverlay.mockImplementation(() => ProbePlain);
    render(<PluginOverlays />);
    const probes = [...document.querySelectorAll("[data-probe]")];
    expect(probes).toHaveLength(2);
    expect(probes.map((p) => p.textContent).sort(),
      "两个 overlay 各自被自己的 PluginIdContext.Provider 包住").toEqual(["id=alpha", "id=beta"]);
  });

  it("④ pluginsNonce 变化 ⇒ 重新收集（否则新加载的插件的 overlay 永远不出现）", () => {
    mockIds.mockReturnValue([]);
    render(<PluginOverlays />);
    expect(document.querySelectorAll("[data-probe]")).toHaveLength(0);
    // 模拟"插件加载完成"：注册表多了一个插件，并 bump nonce 触发重算
    mockIds.mockReturnValue(["late"]);
    mockOverlay.mockImplementation(() => ProbePlain);
    act(() => {
      const s = useUiStore.getState() as unknown as { pluginsNonce: number };
      useUiStore.setState({ pluginsNonce: (s.pluginsNonce ?? 0) + 1 } as never);
    });
    expect(document.querySelectorAll("[data-probe]").length,
      "nonce 变了要重新收集（useMemo 的依赖就是它）").toBe(1);
  });
});
