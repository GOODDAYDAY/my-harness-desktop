// @vitest-environment jsdom
// HoverTip 的 DOM 断言 —— 钉住文件注释里声明的契约:
//   「原生 title 在 Electron/Chromium 里**时延不可控且经常不弹**;用 Radix Tooltip
//     **固定 delayDuration=1000**」
// 即:① 浮层**不会立刻**出现(delayDuration 生效);② 到 1s 才出现且**带文案**;
//     ③ children 作为触发元素**原样渲染**(asChild,不套额外包裹层)。
//
// 为什么值得守:换成原生 `title=` 或把 delayDuration 去掉,组件**照常渲染、不报错**,
// 只是回到"时延不可控、经常不弹"的原始体验——静默退化,正是本会话反复抓到的那类。
// 前置:jsdom 缺 ResizeObserver,仓里 vitest.setup.ts 已全局 stub(为 sidebar 加的,此处同样受益)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { HoverTip } from "./hover-tip";

// 生产里 **Tooltip.Provider 由壳全局提供**(src/web/app-main.tsx:246-254:「唯一一份,
// Radix v1 要求 Root 位于 Provider 之下,任何插件都不再需要自己包」)。
// 所以单测必须复现这个前提——否则 Radix 直接抛 "must be used within TooltipProvider",
// 那是**测试缺了前提**,不是组件有问题。
const renderTip = (text: string): ReturnType<typeof render> =>
  render(<Tooltip.Provider><HoverTip text={text}><button>触发</button></HoverTip></Tooltip.Provider>);


describe("HoverTip(悬停 1s 延迟浮出的解释气泡)", () => {
  it("children 原样作为触发元素渲染(asChild:不套额外包裹层)", () => {
    renderTip("提示文案");
    expect(screen.getByRole("button", { name: "触发" })).toBeInTheDocument();
  });

  it("未悬停时不渲染浮层文案", () => {
    renderTip("提示文案");
    expect(screen.queryByText("提示文案")).toBeNull();
  });

  // ⚠ **未钉住**(如实标注,不假装测过):`delayDuration=1000` 这条契约**至今无人守**。
  //   尝试过:`fireEvent.pointerEnter` + `pointerMove` → 推进假定时器 → `findByText`。
  //   实测**超时**(5s):Radix 的 tooltip 开启依赖它自己的指针/定时器机制,
  //   合成事件 + `vi.useFakeTimers()` 没能驱动它(`vi.advanceTimersByTime` 与 Radix 内部
  //   用的是否同一时间源也要查)。放开假定时器或补 `PointerEvent` polyfill 是下一步。
  //   注意:这条契约**在 DOM 里不可见**(delayDuration 只是 prop,不落属性/样式),
  //   所以除了"真开浮层"没有别的手段能钉它。
  // 不用假定时器:Radix 内部的延迟计时与 `vi` 的时间源未必同一个(上一轮用 fake timers
  // 推进 1.2s 仍超时)。改真实计时:先断言**未到点不出现**,再 waitFor 到点出现。
  // 代价:这条会真的等约 1s —— 换来的是它**真的在验 delayDuration**。
  it("悬停后未到 1s 不出现,到点才带文案出现(delayDuration 生效)", async () => {
    renderTip("提示文案");
    const trigger = screen.getByRole("button", { name: "触发" });

    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    // 刚悬停:不该已经弹出
    expect(screen.queryByText("提示文案"), "浮层未延迟,已退化成「立刻弹出」").toBeNull();
    // **800ms 时仍不该出现** —— 这一条才真正钉住"1000ms"这个量级:
    // Radix 默认延迟是 700ms,若把 delayDuration={1000} 去掉,800ms 时已经弹出了。
    await new Promise((r) => setTimeout(r, 800));
    expect(screen.queryByText("提示文案"), "800ms 就弹出了 —— delayDuration 不是 1000(疑似回落默认 700ms)").toBeNull();

    // 到点后出现(真实等待 ~1s)
    await waitFor(() => expect(screen.getByText("提示文案")).toBeInTheDocument(), { timeout: 3000 });
  }, 10000);
});
