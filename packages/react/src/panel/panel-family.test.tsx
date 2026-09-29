// @vitest-environment jsdom
// Panel 骨架族 8 个组件的行为（r154；此前全部零测试引用，而它们是**所有插件面板的骨架**）。
//
// ## 为什么优先这一族
//
// 它们被每个 sidePanel/settings 插件复用（stickers、review、goal、llm-recorder、
// tool-manager、remote-access…），所以一处行为变化会**同时**改变所有插件面板的外观与交互；
// 而它们又都很小（20–60 行），容易在重构里被"顺手改一下"。
//
// ## 测什么（不测样式）
//
// 样式（CSS 变量、间距）不在这里断言——那属于 r76 的像素对比范畴，且 jsdom 无布局。
// 这里测**行为与语义**：
// · 交互：onClick / onChange 是否触发、**禁用时是否不触发**；
// · 三态属性：`PanelToolbar` 的 title/children 都是 `!= null` 判断（r153 的三态纪律）；
// · ARIA 语义：`PanelTabs` 的 role=tablist/tab + **aria-selected 只对激活项为真**；
//   `PanelIconButton` 的可访问名来自 title（图标按钮没有文本）。
// · 受控组件：`PanelSearchInput` 的 value/onChange 闭环。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  PanelCard, PanelSectionTitle, PanelStatRow, PanelToolbar,
  PanelIconButton, PanelRow, PanelSearchInput, PanelTabs,
} from "./index";

describe("PanelCard / PanelSectionTitle / PanelStatRow：纯呈现骨架", () => {
  it("① PanelCard 原样渲染 children（不吞、不改写）", () => {
    render(<PanelCard><span>卡片内容</span></PanelCard>);
    expect(screen.getByText("卡片内容")).toBeInTheDocument();
  });
  it("② PanelSectionTitle 原样渲染 children", () => {
    render(<PanelSectionTitle>分区标题</PanelSectionTitle>);
    expect(screen.getByText("分区标题")).toBeInTheDocument();
  });
  it("③ PanelStatRow 同时渲染 label 与 value；value 为 **0** 时也要渲染（不能被 falsy 判断吃掉）", () => {
    render(<PanelStatRow label="调用次数" value={0} />);
    expect(screen.getByText("调用次数")).toBeInTheDocument();
    expect(screen.getByText("0"), "0 是合法统计值，falsy 判断会让它消失").toBeInTheDocument();
  });
  it("④ PanelStatRow 的 strong 只影响强调、不影响内容", () => {
    render(<PanelStatRow label="L" value="V" strong />);
    expect(screen.getByText("V")).toBeInTheDocument();
  });
});

describe("PanelToolbar：title/children 的**三态**（r153 纪律）", () => {
  it("① 两者都给 ⇒ 都渲染", () => {
    render(<PanelToolbar title="标题"><button>动作</button></PanelToolbar>);
    expect(screen.getByText("标题")).toBeInTheDocument();
    expect(screen.getByText("动作")).toBeInTheDocument();
  });
  it("② 只给 title ⇒ 不渲染动作容器；只给 children ⇒ 不渲染标题", () => {
    const a = render(<PanelToolbar title="只有标题" />);
    expect(a.container.textContent).toBe("只有标题");
    a.unmount();
    const b = render(<PanelToolbar><span>只有动作</span></PanelToolbar>);
    expect(b.container.textContent).toBe("只有动作");
  });
  it("③ 两者都不给 ⇒ **不抛**、且不留任何文本（判据是 != null，不是 !x）", () => {
    const { container } = render(<PanelToolbar />);
    expect(container.textContent).toBe("");
  });
  it("④ title 传空串仍算**给了**（!= null 与 !x 在空串上分岔）", () => {
    // 这条钉住"空标题"不会退化：若实现改成 !title，空串标题的容器会消失，
    // 布局会与"有标题但内容为空"不同（用户看到工具条塌一格）。
    const { container } = render(<PanelToolbar title="" />);
    expect(container.querySelector("span"), "空串标题仍应渲染标题容器").not.toBeNull();
  });
});

describe("PanelIconButton：图标按钮的可访问名与禁用", () => {
  it("① title 就是可访问名（图标按钮没有文本，名字只能来自 title）", () => {
    render(<PanelIconButton title="刷新">↻</PanelIconButton>);
    expect(screen.getByTitle("刷新")).toBeInTheDocument();
  });
  it("② 点击触发 onClick", () => {
    const onClick = vi.fn();
    render(<PanelIconButton title="刷新" onClick={onClick}>↻</PanelIconButton>);
    fireEvent.click(screen.getByTitle("刷新"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("③ **disabled 时点击不触发**（两侧都要测：能点时要触发、禁用时不许触发）", () => {
    const onClick = vi.fn();
    render(<PanelIconButton title="删除" onClick={onClick} disabled>✕</PanelIconButton>);
    fireEvent.click(screen.getByTitle("删除"));
    expect(onClick, "禁用按钮不该触发回调").not.toHaveBeenCalled();
  });
  it("④ active / danger 只改视觉，不改可点性", () => {
    const onClick = vi.fn();
    render(<PanelIconButton title="高亮" onClick={onClick} active danger>★</PanelIconButton>);
    fireEvent.click(screen.getByTitle("高亮"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("PanelRow：行点击与三个插槽", () => {
  it("① children 与 icon 常驻渲染；**actions 是 hover 才渲染**（钉住这个真实行为）", () => {
    render(<PanelRow icon={<i data-probe="icon" />} actions={<b data-probe="act" />}>行标题</PanelRow>);
    expect(screen.getByText("行标题")).toBeInTheDocument();
    expect(document.querySelector("[data-probe='icon']"), "icon 常驻").not.toBeNull();
    // r154 实测：actions 插槽被 hovered 门控（panel-row.tsx:37 `{hovered && actions != null && …}`）
    expect(document.querySelector("[data-probe='act']"), "未 hover 时操作区不渲染").toBeNull();
  });

  it("①b hover ⇒ 操作区出现；移出 ⇒ 收起（两侧都测）", () => {
    render(<PanelRow actions={<b data-probe="act" />}>行标题</PanelRow>);
    const row = screen.getByText("行标题").closest("div")!;
    fireEvent.mouseEnter(row);
    expect(document.querySelector("[data-probe='act']"), "hover 后应出现").not.toBeNull();
    fireEvent.mouseLeave(row);
    expect(document.querySelector("[data-probe='act']"), "移出后应收起").toBeNull();
  });

  it("①c ⚠ **已知 a11y 缺口钉桩**：键盘聚焦**不会**显示操作区（hovered 只由鼠标事件驱动）", () => {
    // r154 发现：panel-row.tsx 的 hovered 只由 onMouseEnter/onMouseLeave 设置，
    // 没有 onFocus/onBlur 路径 ⇒ 纯键盘用户在 Tab 到这一行时看不到任何操作按钮，
    // 也就无法用键盘触发它们（可访问名普查查不出来：按钮**存在**于 React 树里，
    // 只是没被渲染进 DOM）。这与 r115 那次"差点修一个不存在的 a11y 缺口"相反——
    // 这次是**真的**缺口，但本轮只做钉桩与记录，不在测试轮里改产品行为
    // （改法要与 §7.6/可访问名纪律一起考虑：加 onFocus/onBlur，或让操作区常驻但视觉弱化）。
    render(<PanelRow actions={<button data-probe="kbd">操作</button>}>行标题</PanelRow>);
    const row = screen.getByText("行标题").closest("div")!;
    fireEvent.focus(row);
    expect(document.querySelector("[data-probe='kbd']"),
      "当前行为：聚焦不显示操作区（若哪天修好了，这条会红 ⇒ 那时请把本测试改成断言'聚焦应显示'）").toBeNull();
  });
  it("② 点击行触发 onClick；active 不影响点击", () => {
    const onClick = vi.fn();
    render(<PanelRow onClick={onClick} active>可点行</PanelRow>);
    fireEvent.click(screen.getByText("可点行"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("③ 未给 onClick 时点击**不抛**（行也可以只是展示）", () => {
    render(<PanelRow>纯展示行</PanelRow>);
    expect(() => fireEvent.click(screen.getByText("纯展示行"))).not.toThrow();
  });
});

describe("PanelSearchInput：受控输入闭环", () => {
  it("① 渲染传入的 value 与 placeholder", () => {
    render(<PanelSearchInput value="已输入" onChange={() => {}} placeholder="搜索…" />);
    const input = screen.getByPlaceholderText("搜索…") as HTMLInputElement;
    expect(input.value).toBe("已输入");
  });
  it("② 键入 ⇒ onChange 拿到**原始字符串**（不是事件对象）", () => {
    const onChange = vi.fn();
    render(<PanelSearchInput value="" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0], "契约是 (value: string)，传事件对象会让调用方写 e.target.value").toBe("abc");
  });
  it("③ 清空 ⇒ onChange 拿到空串（不该被当成『没变化』而吞掉）", () => {
    const onChange = vi.fn();
    render(<PanelSearchInput value="abc" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("");
  });
  it("④ 聚焦/失焦不抛（实现里有 focused 状态驱动边框）", () => {
    render(<PanelSearchInput value="" onChange={() => {}} />);
    const input = screen.getByRole("textbox");
    expect(() => { fireEvent.focus(input); fireEvent.blur(input); }).not.toThrow();
  });
});

describe("PanelTabs：tablist 语义与选中态", () => {
  const tabs = [{ label: "全部", value: "all" }, { label: "已完成", value: "done" }];

  it("① 容器是 role=tablist，每项是 role=tab", () => {
    render(<PanelTabs tabs={tabs} activeValue="all" onChange={() => {}} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });
  it("② **aria-selected 只对激活项为真**（两项都真或都假都会让读屏报错误的当前页）", () => {
    render(<PanelTabs tabs={tabs} activeValue="done" onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: "全部" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "已完成" }).getAttribute("aria-selected")).toBe("true");
  });
  it("③ 点击某个 tab ⇒ onChange 拿到**该 tab 的 value**（不是 label、不是下标）", () => {
    const onChange = vi.fn();
    render(<PanelTabs tabs={tabs} activeValue="all" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "已完成" }));
    expect(onChange).toHaveBeenCalledWith("done");
  });
  it("④ 点击**已激活**的 tab 也会回调（幂等由调用方决定，组件不吞点击）", () => {
    const onChange = vi.fn();
    render(<PanelTabs tabs={tabs} activeValue="all" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "全部" }));
    expect(onChange).toHaveBeenCalledWith("all");
  });
  it("⑤ 空 tabs ⇒ 不抛、渲染空 tablist", () => {
    render(<PanelTabs tabs={[]} activeValue="x" onChange={() => {}} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });
});
