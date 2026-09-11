// @vitest-environment jsdom
// FileTreeTab 的 DOM 断言 —— 钉住三处**静默可坏**的语义(该插件此前零 e2e、零单测):
//   ① 无 currentCwd → 只出 EmptyState("先打开文件夹"),**不渲染文件树**
//   ② 有 currentCwd → 头部只显示 **basename**,完整路径放 `title`(悬停可见)
//   ③ **刷新按钮必须让传给 FileTree 的 refreshKey 变化** —— 若它恒定,按钮形同虚设(点了一点反应没有)
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const store = vi.hoisted(() => ({ cwd: null as string | null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  useUiStore: (sel: (s: { currentCwd: string | null }) => unknown) => sel({ currentCwd: store.cwd }),
  // 探针:把收到的 refreshKey 渲染出来,便于断言"刷新键真的变了"
  FileTree: ({ cwd, refreshKey }: { cwd: string; refreshKey: number }) => (
    <div data-testid="tree" data-cwd={cwd} data-key={String(refreshKey)} />
  ),
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty">{title}</div>,
}));

import { FileTreeTab } from "./index";

beforeEach(() => { store.cwd = null; });

describe("FileTreeTab(文件树页签)", () => {
  it("没有当前项目时:只出空态提示,不渲染文件树", () => {
    render(<FileTreeTab />);
    expect(screen.getByTestId("empty")).toHaveTextContent("files.openFolderFirst");
    expect(screen.queryByTestId("tree"), "无项目时仍渲染了文件树").toBeNull();
  });

  it("有当前项目时:头部只显示 basename,完整路径放在 title", () => {
    store.cwd = "/Users/someone/work/my-project";
    render(<FileTreeTab />);
    const head = screen.getByTitle("/Users/someone/work/my-project");
    expect(head).toHaveTextContent("my-project");
    expect(head.textContent, "头部显示了完整路径(应只显示 basename)").not.toContain("/Users/");
    expect(screen.queryByTestId("empty")).toBeNull();
  });

  it("文件树拿到的是当前项目路径", () => {
    store.cwd = "/tmp/proj";
    render(<FileTreeTab />);
    expect(screen.getByTestId("tree")).toHaveAttribute("data-cwd", "/tmp/proj");
  });

  it("点刷新:传给文件树的 refreshKey **变化**(不变则按钮形同虚设)", () => {
    store.cwd = "/tmp/proj";
    render(<FileTreeTab />);
    const before = screen.getByTestId("tree").getAttribute("data-key");
    fireEvent.click(screen.getByRole("button", { name: /common\.refresh/ }));
    const after1 = screen.getByTestId("tree").getAttribute("data-key");
    expect(after1, "点刷新后 key 没变 —— 刷新不会生效").not.toBe(before);

    fireEvent.click(screen.getByRole("button", { name: /common\.refresh/ }));
    const after2 = screen.getByTestId("tree").getAttribute("data-key");
    expect(after2, "第二次刷新没有继续递增").not.toBe(after1);
  });
});
