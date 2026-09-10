// @vitest-environment jsdom
// PhaseIcon 运行中态动画守卫(§目标 15):运行中(思考中/执行工具)必须「明暗交替」(animate-pulse)
// 说明在执行,其余忙碌态(请求/打印/重试/压缩)转圈(animate-spin)——与 timeline 底部指示同语义。
// 按动画类断言,不依赖 lucide 内部类名(渲染层内容,class 是查询契约)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PhaseIcon } from "./phase-icon";

describe("PhaseIcon 运行中态动画(§目标 15)", () => {
  it("thinking(思考中)= 明暗交替(animate-pulse),非转圈", () => {
    const { container } = render(<PhaseIcon phase="thinking" />);
    const svg = container.querySelector("svg")!;
    expect(svg).not.toBeNull();
    expect(svg.classList.contains("animate-pulse")).toBe(true);
    expect(svg.classList.contains("animate-spin")).toBe(false);
  });

  it("toolExecuting(执行工具)= 明暗交替(animate-pulse),非转圈", () => {
    const { container } = render(<PhaseIcon phase="toolExecuting" />);
    const svg = container.querySelector("svg")!;
    expect(svg.classList.contains("animate-pulse")).toBe(true);
    expect(svg.classList.contains("animate-spin")).toBe(false);
  });

  it("其余忙碌态(requesting/outputting 打印中/retrying/compacting)= 转圈(animate-spin)", () => {
    for (const phase of ["requesting", "outputting", "retrying", "compacting"] as const) {
      const { container, unmount } = render(<PhaseIcon phase={phase} />);
      const svg = container.querySelector("svg")!;
      expect(svg.classList.contains("animate-spin")).toBe(true);
      expect(svg.classList.contains("animate-pulse")).toBe(false);
      unmount();
    }
  });
});
