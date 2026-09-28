// @vitest-environment jsdom
// 共享 Button 必须**透传 `data-*` 锚点**。
//
// 为什么值得单测：r32 实测 `ButtonProps` 曾是封闭接口，写在 `<Button data-foo="">` 上的锚点
// 被**静默丢弃**——TypeScript 对 `data-*` 属性不报错（所以 tsc 全绿），DOM 里就是没有那个属性。
// 后果不是某个测试失败，而是**全仓任何用 Button 的控件都挂不上稳定锚点**：
// e2e 与 DOM 审计只能退回"按译文定位"，换语言就失效（skill §17.3 的锚点纪律在按钮上落不了地）。
// 这种"编译期无声、运行期缺失"的缺陷必须有一条 DOM 级断言守着。

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Button } from "./button";

describe("Button：锚点透传与基本行为", () => {
  it("data-* 属性必须出现在真实 DOM 上（不是被静默丢弃）", () => {
    const { container } = render(<Button data-kernel-custom-dir-apply="" data-audit-role="confirm">应用</Button>);
    const btn = container.querySelector("button")!;
    expect(btn.hasAttribute("data-kernel-custom-dir-apply"), "锚点没透传到 DOM —— e2e 将无法定位这个按钮").toBe(true);
    expect(btn.getAttribute("data-audit-role")).toBe("confirm");
  });

  it("多个锚点同时透传，且不影响既有 props（variant/disabled/title/type/onClick）", () => {
    const onClick = vi.fn();
    const { container, rerender } = render(
      <Button variant="secondary" title="提示" type="submit" onClick={onClick} data-a="1" data-b="2">按钮</Button>,
    );
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("data-a")).toBe("1");
    expect(btn.getAttribute("data-b")).toBe("2");
    expect(btn.getAttribute("title")).toBe("提示");
    expect(btn.getAttribute("type")).toBe("submit");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    // disabled 时 onClick 不该触发（浏览器原生行为，但要确认透传没把它破坏）
    rerender(<Button disabled onClick={onClick} data-a="1">按钮</Button>);
    const b2 = container.querySelector("button")!;
    expect(b2.disabled).toBe(true);
    expect(b2.getAttribute("data-a"), "disabled 重渲染后锚点仍在").toBe("1");
    fireEvent.click(b2);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("不传任何 data-* 时按钮照常渲染（透传是可选的，不改变默认形状）", () => {
    const { container } = render(<Button>普通</Button>);
    const btn = container.querySelector("button")!;
    expect(btn.textContent).toContain("普通");
    expect([...btn.attributes].filter((a) => a.name.startsWith("data-"))).toHaveLength(0);
  });
});
