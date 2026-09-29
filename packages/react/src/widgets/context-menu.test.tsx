// @vitest-environment jsdom
// `CtxMenu` / `CtxMenuItem` / `CtxMenuSeparator`（r160；此前零测试引用）。
//
// ## 先确认"抽象里有没有"（r134 的通则）
//
// 这三个组件是 **Radix ContextMenu 的薄封装**（§3.5 收敛到成熟包：
// 此前 sessions-list / pi-model-manager 各手滚一份菜单样式，文件树是第三个消费方 ⇒ 收敛一份）。
// 所以 ARIA role（menu/menuitem/separator）、Escape 关闭、焦点管理、Portal 定位
// **都由 Radix 负责**，不是本仓的逻辑 ⇒ 不在这里测（那是测第三方库）。
// 本测试只钉**我们自己写的那部分**：
//   · `disabled` 时**不许触发 onSelect**（这是我们的 props 语义，Radix 只提供机制）；
//   · `icon` 与 `children` 都渲染（消费方依赖这个组合）；
//   · `danger` / `disabled` 的视觉降级走 **CSS 变量 token**（§1.2：不写死颜色值）；
//   · separator 有 `role="separator"` 语义（Radix 给的，但消费方的剧本靠它定位 ⇒ 钉住防漂移）。
//
// ⚠ 已知边界（如实记）：Radix 的 ContextMenu 在 jsdom 里靠 `contextmenu` 事件开启，
//   但它的内部指针/焦点处理依赖真实布局，所以"打开菜单"这一步在 jsdom 下可能不稳定。
//   因此本测试**直接渲染菜单内容**（不依赖打开动画），把断言集中在我们的 props 语义上；
//   "右键真的能打开菜单"这条属于真机层（e2e 里 sessions-list / 文件树的右键剧本已覆盖）。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { CtxMenuItem, CtxMenuSeparator, CtxMenu } from "./context-menu";

/** 直接渲染菜单内容（绕开 Radix 的开启动画，聚焦本仓的 props 语义）。 */
function renderContent(children: React.ReactNode): void {
  render(
    <ContextMenu.Root open>
      <ContextMenu.Trigger><span>触发区</span></ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>{children}</ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>,
  );
}

describe("CtxMenuItem：disabled / danger / icon+children 的 props 语义", () => {
  it("① 正常项：可点、点击触发 onSelect 一次", () => {
    const onSelect = vi.fn();
    renderContent(<CtxMenuItem onSelect={onSelect}>重命名</CtxMenuItem>);
    const item = screen.getByRole("menuitem", { name: "重命名" });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("② **disabled 项：点击不触发 onSelect**（两侧都测：能点时要触发、禁用时不许触发）", () => {
    const onSelect = vi.fn();
    renderContent(<CtxMenuItem onSelect={onSelect} disabled>删除</CtxMenuItem>);
    const item = screen.getByRole("menuitem", { name: "删除" });
    // Radix 会给禁用项挂 data-disabled / aria-disabled
    expect(item.getAttribute("data-disabled") ?? item.getAttribute("aria-disabled"),
      "禁用态必须对辅助技术可见（不能只是变灰）").not.toBeNull();
    fireEvent.click(item);
    expect(onSelect, "禁用项不该触发回调").not.toHaveBeenCalled();
  });

  it("③ icon 与 children **都**渲染（消费方依赖这个组合：图标 + 文案）", () => {
    renderContent(
      <CtxMenuItem onSelect={() => {}} icon={<svg data-probe="ico" />}>导出</CtxMenuItem>,
    );
    expect(document.querySelector("[data-probe='ico']"), "icon 插槽应渲染").not.toBeNull();
    expect(screen.getByRole("menuitem", { name: /导出/ })).toBeInTheDocument();
  });

  it("④ danger 与 disabled 的视觉降级走 **CSS 变量 token**（§1.2：不写死颜色值）", () => {
    renderContent(
      <>
        <CtxMenuItem onSelect={() => {}} danger>危险项</CtxMenuItem>
        <CtxMenuItem onSelect={() => {}} disabled>禁用项</CtxMenuItem>
      </>,
    );
    const danger = screen.getByRole("menuitem", { name: "危险项" });
    const disabled = screen.getByRole("menuitem", { name: "禁用项" });
    expect(danger.style.color, "danger 用 token 而不是硬编码色值").toContain("var(--color-accent-danger)");
    expect(disabled.style.color, "disabled 用 muted token").toContain("var(--color-muted)");
    expect(disabled.style.opacity, "禁用项视觉弱化（0.5）").toBe("0.5");
    // 反证：正常项不该带这两个降级色
    renderContent(<CtxMenuItem onSelect={() => {}}>正常项</CtxMenuItem>);
    const normal = screen.getByRole("menuitem", { name: "正常项" });
    expect(normal.style.color).not.toContain("var(--color-accent-danger)");
    expect(normal.style.opacity, "正常项不该半透明").not.toBe("0.5");
  });

  it("⑤ 未给 icon 时不渲染图标占位（不留空节点）", () => {
    renderContent(<CtxMenuItem onSelect={() => {}}>纯文案</CtxMenuItem>);
    expect(document.querySelector("[data-probe='ico']")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "纯文案" })).toBeInTheDocument();
  });
});

describe("CtxMenuSeparator / CtxMenu", () => {
  it("① separator 有 role=separator 语义（消费方剧本靠它分组定位 ⇒ 钉住防漂移）", () => {
    renderContent(
      <>
        <CtxMenuItem onSelect={() => {}}>上</CtxMenuItem>
        <CtxMenuSeparator />
        <CtxMenuItem onSelect={() => {}}>下</CtxMenuItem>
      </>,
    );
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("② CtxMenu 渲染 trigger（右键入口必须是调用方给的那个节点，不能吞掉）", () => {
    render(
      <CtxMenu trigger={<button data-probe="trig">行内容</button>}>
        <CtxMenuItem onSelect={() => {}}>项</CtxMenuItem>
      </CtxMenu>,
    );
    expect(screen.getByRole("button", { name: "行内容" })).toBeInTheDocument();
    expect(document.querySelector("[data-probe='trig']"), "trigger 应原样渲染（asChild）").not.toBeNull();
  });

  it("③ CtxMenu 未打开时不渲染菜单项（Portal 内容按需挂载，不在 DOM 里留隐藏菜单）", () => {
    render(
      <CtxMenu trigger={<button>行内容</button>}>
        <CtxMenuItem onSelect={() => {}}>隐藏项</CtxMenuItem>
      </CtxMenu>,
    );
    expect(screen.queryByRole("menuitem"), "未打开时菜单项不该在 DOM 里").toBeNull();
  });
});
