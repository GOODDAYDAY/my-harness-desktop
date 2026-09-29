// @vitest-environment jsdom
// `SortableList` / `SortableListItem`（r166；此前零测试引用）。
//
// ## 层次判定（r143/r160 的纪律：先问哪一层能可靠断言）
//
// 它建在 framer-motion 的 `Reorder` + `useDragControls` 上，所以：
// · **真实拖拽序列**（指针按下→移动→松开、跟手位移、落位动画）属上游 + 需要真实布局
//   ⇒ jsdom 断不了，归真机 e2e（会话列表的拖拽排序剧本已在 scripts/demo 里覆盖）；
// · **本仓的增量**在 DOM 层可断，本测试只钉这些：
//   ① 受控 values 渲染成对应数量的行；② `disabled`（全局）与行级 `disabled` 的传递；
//   ③ `title` 成为行的可访问提示；④ **`useFloatCard` 的主题 token 就绪逻辑**——
//      事件驱动等 `mhd:themeInjected`（不轮询、不猜时序），注入后仍缺 token 才
//      `console.error` 报可行动信息并退化为不透明；⑤ 监听器在卸载时摘除（不泄漏）。
//
// ④⑤ 是这一族里最值得钉的：它们是 r153 那种"缺 token 时的显式降级"逻辑，
// 而**主题 token 缺失只在引导期或主题插件坏掉时发生**——真机 e2e 很难造，
// jsdom 里可以精确控制 `--color-surface` 与事件派发。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { SortableList } from "./sortable-list";
// ⚠ 行组件是**复合形态** SortableList.Item（不是独立导出 SortableListItem）——
//   r166 首版按独立名 import 直接 TS2724。消费方（sessions-list:607）用的也是 SortableList.Item。
const SortableListItem = SortableList.Item;

function setSurfaceToken(v: string | null): void {
  if (v === null) document.documentElement.style.removeProperty("--color-surface");
  else document.documentElement.style.setProperty("--color-surface", v);
}

describe("SortableList：受控顺序与禁用传递", () => {
  beforeEach(() => { setSurfaceToken("#fff"); });
  afterEach(() => { vi.restoreAllMocks(); setSurfaceToken(null); });

  it("① values 渲染成对应数量的行（受控：顺序即数组顺序）", () => {
    const { container } = render(
      <SortableList values={["a", "b", "c"]} onReorder={() => {}}>
        <SortableListItem value="a">甲</SortableListItem>
        <SortableListItem value="b">乙</SortableListItem>
        <SortableListItem value="c">丙</SortableListItem>
      </SortableList>,
    );
    expect(container.textContent).toContain("甲");
    expect(container.textContent).toContain("乙");
    expect(container.textContent).toContain("丙");
  });

  it("② 空 values ⇒ 不抛、渲染空列表（搜索无结果时的情形）", () => {
    expect(() => render(<SortableList values={[]} onReorder={() => {}} />)).not.toThrow();
  });

  it("③ 行级 title 成为可访问提示（拖拽手柄行没有文本时，名字只能来自 title）", () => {
    render(
      <SortableList values={["a"]} onReorder={() => {}}>
        <SortableListItem value="a" title="拖动排序">甲</SortableListItem>
      </SortableList>,
    );
    expect(document.querySelector("[title='拖动排序']"), "title 应落到行上").not.toBeNull();
  });

  it("④ disabled（全局）与行级 disabled 都不该让渲染抛错（禁拖是拖拽属性，不是不渲染）", () => {
    expect(() => render(
      <SortableList values={["a"]} onReorder={() => {}} disabled>
        <SortableListItem value="a" disabled>甲</SortableListItem>
      </SortableList>,
    )).not.toThrow();
    // 禁用时行仍然渲染（用户要看得见列表，只是不能拖）
    expect(document.body.textContent).toContain("甲");
  });
});

describe("useFloatCard：主题 token 就绪的**事件驱动**等待（不轮询、不猜时序）", () => {
  afterEach(() => { vi.restoreAllMocks(); setSurfaceToken(null); });

  function mount(): ReturnType<typeof render> {
    return render(
      <SortableList values={["a"]} onReorder={() => {}} floatCard>
        <SortableListItem value="a">甲</SortableListItem>
      </SortableList>,
    );
  }

  it("① token 已在 ⇒ 就绪，不报错、不挂监听", () => {
    setSurfaceToken("rgb(255,255,255)");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const addSpy = vi.spyOn(window, "addEventListener");
    mount();
    expect(errSpy, "token 在就不该报缺 token").not.toHaveBeenCalled();
    expect(addSpy.mock.calls.some((c) => c[0] === "mhd:themeInjected"),
      "已就绪时不必再挂注入监听（r161 的'断言某事没发生'）").toBe(false);
  });

  it("② token 缺 ⇒ 先不报错，**等 mhd:themeInjected 事件**再复评（事件驱动，不轮询）", () => {
    setSurfaceToken(null);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const addSpy = vi.spyOn(window, "addEventListener");
    mount();
    expect(addSpy.mock.calls.some((c) => c[0] === "mhd:themeInjected"),
      "token 缺时应挂注入监听等主题到位").toBe(true);
    expect(errSpy, "还没到复评时机，不该提前报错（引导期主题尚未注入是正常的）").not.toHaveBeenCalled();
    // 主题注入后复评：token 到位 ⇒ 不报错
    act(() => {
      setSurfaceToken("rgb(1,2,3)");
      window.dispatchEvent(new Event("mhd:themeInjected"));
    });
    expect(errSpy, "注入后 token 到位 ⇒ 不该报缺 token").not.toHaveBeenCalled();
  });

  it("③ 注入后**仍**缺 token ⇒ 报可行动的错误（主题真缺 token，不是时序问题）", () => {
    setSurfaceToken(null);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mount();
    act(() => { window.dispatchEvent(new Event("mhd:themeInjected")); });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const msg = String(errSpy.mock.calls[0][0]);
    expect(msg, "报错要点名缺的是哪个 token（可行动）").toContain("color.surface");
  });

  it("④ 卸载 ⇒ 摘掉 mhd:themeInjected 监听（否则每次挂载多挂一个全局监听）", () => {
    setSurfaceToken(null);
    const rmSpy = vi.spyOn(window, "removeEventListener");
    const utils = mount();
    utils.unmount();
    expect(rmSpy.mock.calls.some((c) => c[0] === "mhd:themeInjected"),
      "useEffect 清理函数应摘掉监听").toBe(true);
  });
});
