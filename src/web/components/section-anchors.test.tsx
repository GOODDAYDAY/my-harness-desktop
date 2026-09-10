// @vitest-environment jsdom
// 框架 Section 的两个声明式锚点 —— 左栏"折叠联动"的信号源契约(§7.3 槽位/组件契约的壳侧消费面)。
//
// 为什么单独一个文件:左栏壳(sidebar.tsx)靠这两个属性判断"这一组现在是不是收起的",
// 并据此把整组的 Panel 塌缩到折叠头高度、把腾出的高度让给后面的组(收起项目区 → 会话区
// 跟上来)。锚点是**跨包契约**:Section 在 packages/react、消费方在 src/web —— 谁单方面
// 改名/删除,折叠联动都会静默失效(属性的丢失不会报错,只是"收起后不再让位")。
// 本守卫把这条契约钉住(§3.7 根因修复留守卫:这正是一个"看着对但什么都不发生"的坑)。
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Section } from "@my-harness-desktop/react";

describe("Section 锚点契约(左栏折叠联动的信号源)", () => {
  it("展开态:无 data-section-collapsed,折叠头挂 data-section-header", () => {
    const { container } = render(<Section title="项目" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.sectionCollapsed).toBeUndefined();
    expect(root.querySelector("[data-section-header]")).toBeTruthy();
  });

  it("收起态:根部挂 data-section-collapsed=true(壳据此把整组面板塌缩)", () => {
    const { container } = render(<Section title="项目" open={false} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.sectionCollapsed).toBe("true");
    // 折叠头仍在(收起的只是内容):塌缩后它必须可见,否则那一组没有展开入口
    expect(root.querySelector("[data-section-header]")).toBeTruthy();
  });

  it("折叠头高度可量:锚点元素不是 0 高度的空壳(壳拿它算塌缩目标高度)", () => {
    const { container } = render(<Section title="项目" actions={<button>+</button>} />);
    const header = container.querySelector("[data-section-header]") as HTMLElement;
    // jsdom 无排版(rect 恒 0),只能断言结构:头部含可点的折叠按钮(带 aria-expanded)
    expect(header.querySelector("button[aria-expanded]")).toBeTruthy();
    expect(header.textContent).toContain("项目");
  });
});
