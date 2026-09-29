// @vitest-environment jsdom
// EntryDivider 的**稳定锚点与可展开性**断言（r241；消费 r240 新加的 data-entry-divider）。
//
// ## 钉的性质
//
// ① `data-entry-divider` 的值就是**中立契约字段 kind**（不是文案、不是内核名）——
//    e2e 靠它探针（dsh-session 用 `[data-entry-divider="model"]` 替代 `innerText.includes("模型 →")`），
//    所以它必须与 kind 一一对应，包括**表里没有的未知 kind**（新 kind 由插件按 names 认领，
//    锚点不能因为图标表没有它就消失）。
// ② **没有 detail 时不声明 aria-expanded**——组件注释明写：没有详情可展开的分隔条
//    挂 `aria-expanded="false"` 等于宣称"这里可以展开"，是**错误承诺**（a11y 层的谎报）。
// ③ 有 detail 时可展开：点击后详情出现、`aria-expanded` 翻转（r223：多态要各钉一面）。
// ④ `tone="error"` 走错误色类（分隔条的严重级不能被吞成普通灰字）。
//
// ⚠ 用键名断言文案（mock 的 t 返回 `key(args)`）：本测试的性质是"锚点与状态"，
//    不是"文案内容"；键存在性由 code-i18n-keys / dynamic-prefix-i18n-keys 守卫负责（r223 的取舍）。

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { EntryDivider } from "./entry-divider";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, a?: Record<string, unknown>) => (a ? `${k}(${JSON.stringify(a)})` : k),
    i18n: { language: "zh-CN" },
  }),
}));

describe("EntryDivider：稳定锚点 = 中立契约字段 kind", () => {
  it("① 已知 kind 原样进锚点（model / compaction / info 三种）", () => {
    for (const kind of ["model", "compaction", "info"]) {
      const { container, unmount } = render(
        <EntryDivider kind={kind} i18nKey={`timeline.${kind}`} i18nArgs={{ provider: "p", modelId: "m" }} />,
      );
      const el = container.querySelector("[data-entry-divider]");
      expect(el, `${kind} 要有锚点`).not.toBeNull();
      expect(el!.getAttribute("data-entry-divider"), "锚点值必须是 kind 本身（不是文案、不是内核名）").toBe(kind);
      unmount();
    }
  });

  it("①b 未知 kind 也原样进锚点（新 kind 由插件认领，锚点不能因图标表没有它就消失）", () => {
    const { container } = render(<EntryDivider kind="someFutureKind" i18nKey="timeline.x" />);
    expect(container.querySelector('[data-entry-divider="someFutureKind"]'),
      "未知 kind 仍要暴露锚点——否则新增分隔条类型的 e2e 探针会失效").not.toBeNull();
  });

  it("② 没有 detail 时**不声明** aria-expanded（挂了就是错误承诺：宣称可展开）", () => {
    const { container } = render(<EntryDivider kind="model" i18nKey="timeline.modelChange" />);
    const btn = container.querySelector("button");
    expect(btn, "分隔条仍要有一个按钮承载文案").not.toBeNull();
    expect(btn!.hasAttribute("aria-expanded"),
      "无 detail 时不该有 aria-expanded（组件注释：那是'错误承诺'）").toBe(false);
  });

  it("③ 有 detail 时可展开：点击后详情出现、aria-expanded 翻转", () => {
    const { container, getByText } = render(
      <EntryDivider kind="compaction" i18nKey="timeline.compaction" detail="压缩了 12000 tokens" />,
    );
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("压缩了 12000 tokens");
    fireEvent.click(btn);
    expect(container.querySelector("button")!.getAttribute("aria-expanded"), "点击后要翻转").toBe("true");
    expect(getByText(/压缩了 12000 tokens/), "详情要真的渲染出来").toBeTruthy();
  });

  it("④ tone=error 走错误色类（严重级不能被吞成普通灰字）", () => {
    const { container } = render(<EntryDivider kind="retry" i18nKey="timeline.retry" tone="error" />);
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("var(--color-accent-error)");
    const { container: c2 } = render(<EntryDivider kind="retry" i18nKey="timeline.retry" />);
    expect(c2.querySelector("button")!.className, "缺省 tone 不该用错误色").not.toContain("var(--color-accent-error)");
  });
});
