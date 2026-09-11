// @vitest-environment jsdom
// PumlCodeBlock 的 DOM 断言 —— 钉住它注释里写明的"永不空白"契约:
//   「编码/加载失败**与流式期间**都自降级为源码呈现,消费方不感知」
// 以及加载态动效(需求 §15:运行中要么动起来的 icon):
//   ① 流式期间 → 源码兜底(不打完的图不该去请求,也不该空白)
//   ② 编码失败(encoder 抛错 → url=null) → 源码兜底
//   ③ **加载失败(img onError)→ 源码兜底**(网络/服务端故障不显示空白)
//   ④ 加载中 → 出现**转动**指示(animate-spin)且 img 暂不显示
//   ⑤ 加载成功(onLoad)→ img 显示
//
// ⚠ 读取方式(skills §10.5 第 13 条):兜底断言**不用 `getByText`** —— 它默认归一化空白,
//   会把 "@startuml\nA->B\n@enduml" 与 "@startuml A->B @enduml" 视为同一串,
//   正好抹平被验的差异(上一版就是这么红掉的)。改用 `pre.textContent` **精确相等**:
//   既不过宽也不空转。实测 DOM 里 <pre> 的 textContent 与传入 code **逐字相同**。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({ encodeThrows: false }));
vi.mock("plantuml-encoder", () => ({
  default: {
    encode: (code: string) => {
      if (h.encodeThrows) throw new Error("encode failed");
      return "ENC(" + code + ")";
    },
  },
}));

import { PumlCodeBlock } from "./index";

const CODE = "@startuml\nA->B\n@enduml";
const img = (): HTMLImageElement | null => document.querySelector("img");
const spinner = (): Element | null => document.querySelector(".animate-spin");
const pre = (): HTMLPreElement | null => document.querySelector("pre");

beforeEach(() => { h.encodeThrows = false; });

describe("PumlCodeBlock(围栏渲染:永不空白 + 加载动效)", () => {
  it("① 流式期间 → 源码兜底(不请求、不空白)", () => {
    render(<PumlCodeBlock code={CODE} streaming />);
    expect(pre()?.textContent, "流式期间没有回落成源码").toBe(CODE);
    expect(img(), "流式期间仍发起了渲染请求").toBeNull();
  });

  it("② 编码失败 → 源码兜底", () => {
    h.encodeThrows = true;
    render(<PumlCodeBlock code={CODE} />);
    expect(pre()?.textContent, "编码失败后没有回落成源码").toBe(CODE);
    expect(img()).toBeNull();
  });

  it("③ **onError → 源码兜底**(失败不显示空白)", () => {
    render(<PumlCodeBlock code={CODE} />);
    fireEvent.error(img()!);
    expect(pre()?.textContent, "加载失败后没有回落成源码").toBe(CODE);
    expect(img(), "失败后 img 还在 DOM 里").toBeNull();
  });

  it("④ 正常路径:先出**转动的**指示,img 暂不显示", () => {
    render(<PumlCodeBlock code={CODE} />);
    expect(spinner(), "加载中没有动效指示(§15)").not.toBeNull();
    expect(img()!.style.display, "加载中 img 就显示了").toBe("none");
    expect(pre(), "正常路径不该出现源码兜底").toBeNull();
  });

  it("⑤ onLoad → img 显示且转圈消失", () => {
    render(<PumlCodeBlock code={CODE} />);
    fireEvent.load(img()!);
    expect(img()!.style.display).toBe("block");
    expect(spinner(), "加载完成后指示仍在").toBeNull();
  });

  it("请求 URL 带编码后的源码(真的用了 encoder)", () => {
    render(<PumlCodeBlock code={CODE} />);
    expect(img()!.getAttribute("src")).toContain("ENC(" + CODE + ")");
    expect(img()!.getAttribute("src")).toContain("/svg/");
  });
});
