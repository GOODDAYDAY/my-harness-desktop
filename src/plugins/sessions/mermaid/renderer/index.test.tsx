// @vitest-environment jsdom
// MermaidCodeBlock 的 DOM 断言 —— 三兄弟里最后一个(fallback 三份逐字相同)。
// 它比 graphviz 多三处可钉契约:
//   ① **主题跟随背景亮度**:`theme: isDarkMode() ? "dark" : "default"`
//      —— 而 isDarkMode 读 `getComputedStyle(document.body).backgroundColor`:
//      jsdom 默认取不到颜色 → 正则不命中 → **回落"暗色"**;亮背景 → "default"。
//   ② **`securityLevel: "strict"`**(安全:图里注入的内容不许跑脚本)
//   ③ **render id 每次唯一**(重复 id 会让 mermaid 渲染互相踩)
// 加上与两个兄弟同形的"永不空白"三条。
//
// 读取方式:`pre.textContent` 逐字精确相等(不用 getByText —— 它归一化空白会抹平差异,
// skills §10.5 第 13 条);异步断言前**先 flush**(否则断的是竞态,见第 13/17 条)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  inits: [] as Record<string, unknown>[],
  ids: [] as string[],
  renderThrows: false,
  importCalls: 0,
}));
vi.mock("mermaid", () => ({
  default: {
    initialize: (opts: Record<string, unknown>) => { h.inits.push(opts); },
    render: async (id: string, _code: string) => {
      h.ids.push(id);
      h.importCalls += 1;
      if (h.renderThrows) throw new Error("render failed");
      return { svg: `<svg id="${id}"></svg>` };
    },
  },
}));

import { MermaidCodeBlock } from "./index";

const CODE = "graph TD; A-->B";
const pre = (): HTMLPreElement | null => document.querySelector("pre");
const spinner = (): Element | null => document.querySelector(".animate-spin");

beforeEach(() => {
  h.inits = []; h.ids = []; h.renderThrows = false; h.importCalls = 0;
  document.body.style.backgroundColor = "";
});

describe("MermaidCodeBlock(围栏渲染:永不空白 + 主题/安全/id)", () => {
  it("① 流式期间 → 源码兜底,**且不尝试渲染**", async () => {
    render(<MermaidCodeBlock code={CODE} streaming />);
    expect(pre()?.textContent, "流式期间没有回落成源码").toBe(CODE);
    await new Promise((r) => setTimeout(r, 20));   // 先 flush 再断言,否则断的是竞态
    expect(h.importCalls, "流式期间仍去渲染了").toBe(0);
  });

  it("③ 渲染中 → 出现**转动**指示(§15)", () => {
    render(<MermaidCodeBlock code={CODE} />);
    expect(spinner(), "渲染中没有动效指示").not.toBeNull();
    expect(pre()).toBeNull();
  });

  it("④ 成功 → SVG 被注入", async () => {
    const { container } = render(<MermaidCodeBlock code={CODE} />);
    await waitFor(() => expect(container.querySelector("svg"), "SVG 没有被注入").not.toBeNull());
    expect(spinner(), "渲染完成后指示仍在").toBeNull();
  });

  it("② **渲染失败 → 源码兜底**(失败不显示空白)", async () => {
    h.renderThrows = true;
    render(<MermaidCodeBlock code={CODE} />);
    await waitFor(() => expect(pre()?.textContent, "渲染失败后没有回落成源码").toBe(CODE));
    expect(spinner()).toBeNull();
  });

  it("★ 主题跟随背景:取不到背景色 → dark;亮背景 → default", async () => {
    render(<MermaidCodeBlock code={CODE} />);
    await waitFor(() => expect(h.inits.length).toBeGreaterThan(0));
    expect(h.inits[0].theme, "取不到背景色时没有回落到暗色主题").toBe("dark");
  });

  it("★ 亮背景 → default 主题", async () => {
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    render(<MermaidCodeBlock code={CODE} />);
    await waitFor(() => expect(h.inits.length).toBeGreaterThan(0));
    expect(h.inits[0].theme, "亮背景没有切到 default 主题").toBe("default");
  });

  it("★ 安全:securityLevel 必须是 strict", async () => {
    render(<MermaidCodeBlock code={CODE} />);
    await waitFor(() => expect(h.inits.length).toBeGreaterThan(0));
    expect(h.inits[0].securityLevel, "securityLevel 不是 strict(图里注入的内容可能可执行)").toBe("strict");
    expect(h.inits[0].startOnLoad).toBe(false);
  });

  it("★ render id 每次唯一(重复 id 会让多次渲染互相踩)", async () => {
    const { rerender } = render(<MermaidCodeBlock code={CODE} />);
    await waitFor(() => expect(h.ids.length).toBe(1));
    rerender(<MermaidCodeBlock code={"graph TD; X-->Y"} />);
    await waitFor(() => expect(h.ids.length).toBe(2));
    expect(h.ids[0], "两次渲染用了同一个 id").not.toBe(h.ids[1]);
  });
});
