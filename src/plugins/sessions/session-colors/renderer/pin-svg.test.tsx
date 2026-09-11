// @vitest-environment jsdom
// PinSVG 的 DOM 断言 —— 13 行、零 hook 的纯展示组件(零 mock 即可测)。
// 钉住三处**静默可坏**的契约:
//   ① `color` 必须到达**每一处**着色面:头部 ellipse 的 fill、以及三根 stem path 的 stroke。
//      漏掉任何一处不会报错,只会让图钉**局部失色** —— 而那一眼看上去"像是主题没配好"。
//   ② 高光是**固定的** rgba(255,255,255,0.35),**不是**传入的 color:
//      它是刻意留下的对比点;若有人"顺手统一"成 color,高光会静默消失。
//   ③ viewBox 是固定画布(0 0 22 26) —— 改动会静默缩放整个图钉。
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { PinSVG } from "./pin-svg";

const HEAD_FILL = "rgba(255,255,255,0.35)";
const svgOf = (c: HTMLElement): SVGSVGElement => c.querySelector("svg")!;

describe("PinSVG(会话色图钉)", () => {
  it("① color 到达每一处着色面(1 个 fill + 3 个 stroke),没有漏项", () => {
    const { container } = render(<PinSVG color="#ff8800" />);
    const svg = svgOf(container);
    // 头部圆(不含高光):fill 应为 color
    const filled = [...svg.querySelectorAll("ellipse")].filter((e) => e.getAttribute("fill") === "#ff8800");
    expect(filled.length, "头部圆没有用传入的 color 填充").toBe(1);
    // 三根 stem:stroke 都应为 color
    const stroked = [...svg.querySelectorAll("path")].filter((p) => p.getAttribute("stroke") === "#ff8800");
    expect(stroked.length, "有 stem 路径没有跟着 color(图钉会局部失色)").toBe(3);
  });

  it("② 高光是固定的白色半透明,**不**跟着 color 变", () => {
    const { container } = render(<PinSVG color="#ff8800" />);
    const glossy = [...svgOf(container).querySelectorAll("ellipse")].filter(
      (e) => e.getAttribute("fill") === HEAD_FILL,
    );
    expect(glossy.length, "高光被改成了传入 color(对比点静默消失)").toBe(1);
  });

  it("③ 画布 viewBox 固定为 0 0 22 26", () => {
    const { container } = render(<PinSVG color="#123456" />);
    expect(svgOf(container).getAttribute("viewBox")).toBe("0 0 22 26");
  });

  it("style 透传到 svg 上(调用方定位用)", () => {
    const { container } = render(<PinSVG color="#123456" style={{ marginTop: "3px" }} />);
    expect(svgOf(container).style.marginTop).toBe("3px");
  });
});
