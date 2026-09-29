// @vitest-environment jsdom
// MessageStatusFlags 的三态与锚点断言（r243；组件是本轮从 TimelineView 的内联 JSX 抽出的）。
//
// ## 钉的性质
//
// ① 既没停止也没失败 ⇒ **什么都不渲染**（不该多出空条占位）；
// ② 只有 stopped ⇒ 出 `data-message-stopped`，且**不**出 `data-message-error`；
// ③ 只有 error ⇒ 出 `data-message-error`，且**不**出 `data-message-stopped`；
// ④ 两者同时 ⇒ 两条都在（它们不是互斥态：先停止后又标失败的会话真实存在）；
// ⑤ error 带 errorMessage ⇒ 详情渲染出来；不带 ⇒ 只有标题（不该渲染空详情节点）。
//
// 每条都断言"另一态没出现"（r223：N 态展示要配 N 条断言，且每条断言另外几态没出现——
// 最常见的退化是两个分支同时命中）。锚点是 e2e 的稳定探针（§1.2/r113：探针不绑文案；
// r96：断言状态位要让产品暴露状态位本身），所以它们必须与状态一一对应。
//
// ⚠ 断言用键名（mock 的 t 返回 key）：本测试的性质是"哪个状态被渲染"，
//    键存在性由 code-i18n-keys 守卫负责（r223 的取舍）。

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MessageStatusFlags } from "./index";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh-CN" } }),
}));

describe("MessageStatusFlags：三态与锚点一一对应", () => {
  it("① 无停止无失败 ⇒ 什么都不渲染", () => {
    const { container } = render(<MessageStatusFlags />);
    expect(container.querySelector("[data-message-stopped]")).toBeNull();
    expect(container.querySelector("[data-message-error]")).toBeNull();
    expect(container.textContent, "不该留下空条占位").toBe("");
  });

  it("② 只有 stopped ⇒ 出 data-message-stopped，不出 error", () => {
    const { container } = render(<MessageStatusFlags stopped />);
    expect(container.querySelector("[data-message-stopped]"), "停止态要有锚点").not.toBeNull();
    expect(container.querySelector("[data-message-error]"), "没失败就不该有失败条").toBeNull();
    expect(container.textContent).toContain("shell.stopped");
  });

  it("③ 只有 error ⇒ 出 data-message-error，不出 stopped", () => {
    const { container } = render(<MessageStatusFlags error />);
    expect(container.querySelector("[data-message-error]"), "失败态要有锚点（e2e 靠它探针）").not.toBeNull();
    expect(container.querySelector("[data-message-stopped]")).toBeNull();
    expect(container.textContent).toContain("shell.error");
  });

  it("④ 两者同时 ⇒ 两条都在（不是互斥态）", () => {
    const { container } = render(<MessageStatusFlags stopped error />);
    expect(container.querySelector("[data-message-stopped]")).not.toBeNull();
    expect(container.querySelector("[data-message-error]"),
      "停止与失败可以同时成立（先停止后标失败），不能互斥掉一条").not.toBeNull();
  });

  it("⑤ error 带 errorMessage ⇒ 渲染详情；不带 ⇒ 不渲染空详情节点", () => {
    const { container, rerender } = render(<MessageStatusFlags error errorMessage="上游 500" />);
    expect(container.textContent).toContain("上游 500");
    rerender(<MessageStatusFlags error />);
    expect(container.querySelector("[data-message-error]")!.textContent).toBe("shell.error");
    // 非字符串的 errorMessage（例如对象）不该被渲染成 [object Object]
    rerender(<MessageStatusFlags error errorMessage={{ code: 500 }} />);
    expect(container.querySelector("[data-message-error]")!.textContent,
      "非字符串详情不渲染（此前就是 typeof === 'string' 的判断，抽出后要保持）").toBe("shell.error");
  });
});
