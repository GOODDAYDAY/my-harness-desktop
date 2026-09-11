// @vitest-environment jsdom
// GraphvizCodeBlock 的 DOM 断言 —— 与 puml 同一套"永不空白"契约(fallback 三份逐字相同),
// 差别在它**动态渲染**:动态 import @viz-js/viz → renderString → 注入 SVG。
//   ① 流式期间 → 源码兜底,**且根本不尝试渲染**(不该为没打完的代码去加载 viz)
//   ② 渲染失败(renderString 抛错) → 源码兜底(失败不显示空白)
//   ③ 渲染中(尚无 svg) → 出现**转动**指示(§15)
//   ④ 成功 → SVG 被注入
//
// 读取方式同 puml:`pre.textContent` **逐字精确相等**(不用 getByText —— 它归一化空白会抹平差异,
// 见 skills §10.5 第 13 条)。
//
// ⚠ 测试顺序陷阱:`getViz()` 里 `vizPromise ??=` **缓存模块级 promise** → 跨用例复用。
//   所以**不能让 instance() 失败**(会把缓存毒化给后续用例),而应让 instance() 恒成功、
//   由 `renderString` 决定成败 —— renderString 是每次渲染都调的,天然是每个用例独立的。
//
// ⚠ 不用假定时器(skills §10.5 第 11 条:动态 import 的时序不在 vi 的时钟上),用真实 await。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ renderThrows: false, renderCalls: 0, instanceCalls: 0 }));
vi.mock("@viz-js/viz", () => ({
  instance: async () => {
    h.instanceCalls += 1;
    return {
      renderString: (_code: string, _opts: unknown) => {
        h.renderCalls += 1;
        if (h.renderThrows) throw new Error("render failed");
        return "<svg><g id='GV'></g></svg>";
      },
    };
  },
}));

import { GraphvizCodeBlock } from "./index";

const CODE = "digraph { a -> b }";
const pre = (): HTMLPreElement | null => document.querySelector("pre");
const spinner = (): Element | null => document.querySelector(".animate-spin");

beforeEach(() => { h.renderThrows = false; h.renderCalls = 0; h.instanceCalls = 0; });

describe("GraphvizCodeBlock(围栏渲染:永不空白 + 渲染动效)", () => {
  it("① 流式期间 → 源码兜底,**且不尝试渲染**", async () => {
    render(<GraphvizCodeBlock code={CODE} streaming />);
    expect(pre()?.textContent, "流式期间没有回落成源码").toBe(CODE);
    // ⚠ 必须**先等异步 flush 再断言**:effect 里的 getViz() 是异步的,
    // 同步断言时它还没发生 —— 那样写等于"断言一个竞态",**任何实现都会通过**
    // (实测:去掉 effect 里的 `if (streaming) return` 后,同步断言照样绿)。
    await new Promise((r) => setTimeout(r, 20));
    expect(h.instanceCalls, "流式期间仍去加载/渲染了 viz").toBe(0);
    expect(h.renderCalls).toBe(0);
  });

  it("③ 渲染中 → 出现**转动**指示(§15)", () => {
    render(<GraphvizCodeBlock code={CODE} />);
    expect(spinner(), "渲染中没有动效指示").not.toBeNull();
    expect(pre(), "渲染中不该已经出兜底").toBeNull();
  });

  it("④ 成功 → SVG 被注入", async () => {
    const { container } = render(<GraphvizCodeBlock code={CODE} />);
    await waitFor(() => expect(h.renderCalls).toBe(1));
    await waitFor(() => expect(container.querySelector("#GV"), "SVG 没有被注入").not.toBeNull());
    expect(spinner(), "渲染完成后指示仍在").toBeNull();
    expect(pre()).toBeNull();
  });

  it("② **渲染失败 → 源码兜底**(失败不显示空白)", async () => {
    h.renderThrows = true;
    render(<GraphvizCodeBlock code={CODE} />);
    await waitFor(() => expect(pre()?.textContent, "渲染失败后没有回落成源码").toBe(CODE));
    expect(spinner(), "失败后仍在转圈").toBeNull();
  });

  it("②b 失败后再切回可用:同一个组件能恢复(不卡在失败态)", async () => {
    h.renderThrows = true;
    const { container, rerender } = render(<GraphvizCodeBlock code={CODE} />);
    await waitFor(() => expect(pre()).not.toBeNull());

    h.renderThrows = false;
    rerender(<GraphvizCodeBlock code={"digraph { x -> y }"} />);
    await waitFor(() => expect(container.querySelector("#GV"), "换代码后没有重新渲染成功").not.toBeNull());
    expect(pre(), "恢复后仍停在兜底").toBeNull();
  });
});
