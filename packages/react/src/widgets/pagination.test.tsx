// @vitest-environment jsdom
// 分页部件的可访问语义。
//
// 为什么值得单测：r38 的全应用 a11y 普查（`scripts/demo/a11y-names-audit.e2e.mjs`，
// 23 个视图 / 1379 个可交互元素）查出无名元素只有 3 种，其中 **2 种就是这个部件的左右箭头**
// ——共享部件的缺陷会被所有消费方复制一遍。普查是真机级的兜底（成本高、跑得慢），
// 这条单测是提交前就能拦住的第一道。
//
// 两个判据都不是"有没有 aria 属性"这种装饰性检查：
//   ① 纯图标按钮**必须有可访问名**，且名字来自 props（发布面不许写死文案，§1.2）；
//   ② 页码按钮有数字文本所以"有名字"，但光念"3"听不出是**当前页** → 必须有 aria-current="page"。

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Pagination } from "./pagination";

const LABELS = { prevLabel: "上一页", nextLabel: "下一页" };

describe("Pagination：可访问名与当前页语义", () => {
  it("左右箭头是纯图标，必须有来自 props 的可访问名（不能是空按钮）", () => {
    const { container } = render(<Pagination currentPage={2} totalPages={5} onPageChange={() => {}} {...LABELS} />);
    const prev = container.querySelector('[data-pagination="prev"]')!;
    const next = container.querySelector('[data-pagination="next"]')!;
    expect(prev.getAttribute("aria-label"), "上一页按钮缺可访问名 —— 读屏只会念「按钮」").toBe("上一页");
    expect(next.getAttribute("aria-label")).toBe("下一页");
    // 名字必须真的来自 props（发布面写死文案会违 §1.2，也无法翻译）
    const { container: c2 } = render(<Pagination currentPage={1} totalPages={3} onPageChange={() => {}} prevLabel="Previous page" nextLabel="Next page" />);
    expect(c2.querySelector('[data-pagination="prev"]')?.getAttribute("aria-label")).toBe("Previous page");
  });

  it("恰好一个页码带 aria-current=page，且它就是 currentPage", () => {
    const { container, rerender } = render(<Pagination currentPage={3} totalPages={5} onPageChange={() => {}} {...LABELS} />);
    const current = [...container.querySelectorAll('[aria-current="page"]')];
    expect(current, "必须有且只有一个当前页标记").toHaveLength(1);
    expect(current[0].getAttribute("data-pagination-page")).toBe("3");
    expect(current[0].textContent).toBe("3");
    rerender(<Pagination currentPage={1} totalPages={5} onPageChange={() => {}} {...LABELS} />);
    expect(container.querySelector('[aria-current="page"]')?.getAttribute("data-pagination-page")).toBe("1");
  });

  it("非当前页的页码**不带** aria-current（全都标等于没标）", () => {
    const { container } = render(<Pagination currentPage={2} totalPages={4} onPageChange={() => {}} {...LABELS} />);
    const pages = [...container.querySelectorAll("[data-pagination-page]")];
    expect(pages).toHaveLength(4);
    expect(pages.filter((p) => p.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("边界：首页时「上一页」禁用、末页时「下一页」禁用（禁用态用原生 disabled，可访问性由浏览器保证）", () => {
    const { container, rerender } = render(<Pagination currentPage={1} totalPages={3} onPageChange={() => {}} {...LABELS} />);
    expect((container.querySelector('[data-pagination="prev"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-pagination="next"]') as HTMLButtonElement).disabled).toBe(false);
    rerender(<Pagination currentPage={3} totalPages={3} onPageChange={() => {}} {...LABELS} />);
    expect((container.querySelector('[data-pagination="next"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("点页码/箭头回调正确的目标页（1-based）", () => {
    const onPageChange = vi.fn();
    const { container } = render(<Pagination currentPage={2} totalPages={5} onPageChange={onPageChange} {...LABELS} />);
    fireEvent.click(container.querySelector('[data-pagination-page="4"]')!);
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    fireEvent.click(container.querySelector('[data-pagination="next"]')!);
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    fireEvent.click(container.querySelector('[data-pagination="prev"]')!);
    expect(onPageChange).toHaveBeenLastCalledWith(1);
  });

  it("totalPages <= 1 时整个部件不渲染（调用方不必自包条件）", () => {
    const { container } = render(<Pagination currentPage={1} totalPages={1} onPageChange={() => {}} {...LABELS} />);
    expect(container.querySelector("[data-pagination='prev']")).toBeNull();
    expect(container.querySelectorAll("[data-pagination-page]")).toHaveLength(0);
  });
});
