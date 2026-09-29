// @vitest-environment jsdom
// Select 的契约断言（r251；消化发布面零测试引用清单里的 Select）。
//
// ## 钉的性质
//
// Select 是发布面（§7.2：壳插件唯一能用的 API 面）里的表单控件，多处插件在用。
// ① 渲染出**原生 select**（不是自绘 listbox）⇒ 键盘/读屏行为由平台保证；
// ② `ariaLabel` 落到 select 上（它是这个控件的**可访问名**——没有它读屏只会念"组合框"）；
// ③ `onChange` 回调收到的是**选项值**而不是事件对象（这是它对外的契约，
//    消费方都写 `onChange={(v) => …}`；若哪天改成传事件，所有消费方会静默拿到错的东西）；
// ④ `disabled` ⇒ select 真的 disabled（不是只改样式）；
// ⑤ `mono` ⇒ 用等宽字体族（模型名/路径这类内容需要等宽对齐）；
// ⑥ **`style` 落在 wrapper 上、不落在 select 上**——组件注释明写这是布局职责的划分
//    （"style 落在 wrapper(布局职责:宽度/伸缩)，select 内部始终填满 wrapper"）；
//    若哪天落到 select 上，消费方给的宽度会被 select 的 `width:100%` 吃掉 ⇒ 布局回归。
// ⑦ children 里的 option 原样渲染（Select 不接管选项形状）。
//
// ⚠ 断言用**角色/属性**查元素，不用 class 查（§5.6 第二级的写法）。

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Select } from "./select";

describe("Select：原生 select + 可访问名 + onChange 传值", () => {
  it("①②⑦ 渲染原生 select、带 aria-label、children 的 option 原样渲染", () => {
    const { container, getByRole } = render(
      <Select value="a" onChange={() => {}} ariaLabel="挑一个">
        <option value="a">甲</option>
        <option value="b">乙</option>
      </Select>,
    );
    const sel = getByRole("combobox") as HTMLSelectElement;
    expect(sel.tagName, "必须是原生 select（键盘/读屏行为由平台保证）").toBe("SELECT");
    expect(sel.getAttribute("aria-label"), "ariaLabel 是这个控件的可访问名").toBe("挑一个");
    expect(container.querySelectorAll("option")).toHaveLength(2);
    expect(sel.value).toBe("a");
  });

  it("③ onChange 收到的是**选项值**，不是事件对象（对外契约）", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <Select value="a" onChange={onChange} ariaLabel="挑一个">
        <option value="a">甲</option>
        <option value="b">乙</option>
      </Select>,
    );
    fireEvent.change(getByRole("combobox"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0], "消费方都写 (v) => …，传事件对象会静默拿错东西").toBe("b");
  });

  it("④ disabled ⇒ select 真的 disabled（不是只改样式）", () => {
    const { getByRole } = render(
      <Select value="a" onChange={() => {}} disabled ariaLabel="挑一个">
        <option value="a">甲</option>
      </Select>,
    );
    expect((getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
  });

  it("⑤ mono ⇒ 用等宽字体族；缺省 ⇒ 用无衬线字体族", () => {
    const { getByRole, rerender } = render(
      <Select value="a" onChange={() => {}} mono ariaLabel="挑一个">
        <option value="a">甲</option>
      </Select>,
    );
    expect((getByRole("combobox") as HTMLSelectElement).style.fontFamily).toContain("mono");
    rerender(
      <Select value="a" onChange={() => {}} ariaLabel="挑一个">
        <option value="a">甲</option>
      </Select>,
    );
    expect((getByRole("combobox") as HTMLSelectElement).style.fontFamily).toContain("sans");
  });

  it("⑥ style 落在 **wrapper** 上、不落在 select 上（布局职责划分）", () => {
    const { container, getByRole } = render(
      <Select value="a" onChange={() => {}} ariaLabel="挑一个" style={{ width: 240, flexGrow: 2 }}>
        <option value="a">甲</option>
      </Select>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    const sel = getByRole("combobox") as HTMLSelectElement;
    expect(wrapper.style.width, "消费方给的宽度要落在 wrapper 上").toBe("240px");
    expect(sel.style.width, "select 内部始终填满 wrapper（width:100%），不吃消费方的宽度").toBe("100%");
  });
});
