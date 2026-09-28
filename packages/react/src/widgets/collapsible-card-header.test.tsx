// @vitest-environment jsdom
// 可折叠卡片头：交互语义 + **防再分叉**守卫（r57）。
//
// 这个组件的存在理由就是消除重复：此前 message-blocks 的 `CardHeader` 与 goal 插件的
// `GoalCard` 各有一份逐字相同的可折叠头，r41 修了前者的三个缺陷（缺 aria-expanded、
// 硬编码英文 running、纯图标状态无可访问名），后者**一个不少地留到 r52**才发现。
// 所以这里除了测组件本身的语义，还要钉住"两个调用方都在用它"——
// 否则下一次有人图省事再内联一份，同样的漂移会重来一遍。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CollapsibleCardHeader, ExecutionStatus } from "./collapsible-card-header";

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/react/src/widgets → 仓库根是 **4** 级（首版写 3 级，于是读到了 packages/src/… 报 ENOENT）
const ROOT = join(HERE, "..", "..", "..", "..");

const DICT: Record<string, string> = JSON.parse(
  readFileSync(join(ROOT, "src/plugins/system/i18n/locales/zh-CN/shell.json"), "utf-8"),
) as Record<string, string>;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string): string => DICT[k] ?? k,
    i18n: { exists: (k: string) => k in DICT, language: "zh-CN" },
  }),
}));

describe("CollapsibleCardHeader：折叠语义三件套要么全给要么全撤", () => {
  it("可展开时：role=button + tabIndex=0 + Enter/Space 键处理 + aria-expanded 全在场，且随按键翻转", () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <CollapsibleCardHeader borderColor="var(--color-primary)" collapsed summary="摘要" onToggle={onToggle} />,
    );
    const head = container.querySelector('[data-collapsible-header]')!;
    expect(head.getAttribute("role")).toBe("button");
    expect(head.getAttribute("tabindex")).toBe("0");
    expect(head.getAttribute("aria-expanded"), "收起时是 false").toBe("false");
    fireEvent.keyDown(head, { key: "Enter" });
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(head, { key: " " });
    expect(onToggle, "空格键同样能切").toHaveBeenCalledTimes(2);
    rerender(<CollapsibleCardHeader borderColor="var(--color-primary)" collapsed={false} summary="摘要" onToggle={onToggle} />);
    expect(head.getAttribute("aria-expanded"), "展开后必须翻成 true").toBe("true");
  });

  it("不可展开时：三件套**全撤**，也不画 chevron（给点了不动的元素挂 aria-expanded 是错误承诺）", () => {
    const { container } = render(
      <CollapsibleCardHeader borderColor="var(--color-primary)" collapsed summary="摘要" onToggle={() => {}} expandable={false} />,
    );
    const head = container.querySelector('[data-collapsible-header]')!;
    expect(head.getAttribute("role"), "不该有 button 语义").toBeNull();
    expect(head.getAttribute("tabindex"), "不该进 Tab 序").toBeNull();
    expect(head.getAttribute("aria-expanded"), "不该声明展开态").toBeNull();
    expect(head.querySelectorAll("svg").length, "不该画 chevron（没有可展开的详情）").toBe(0);
    expect(head.className, "不该显示可点的手型光标").not.toContain("cursor-pointer");
  });

  it("内容全部经插槽进来：图标 / 摘要 / 状态 / 尾随槽都渲染，且顺序是 图标→摘要→状态→尾随→chevron", () => {
    const { container } = render(
      <CollapsibleCardHeader
        borderColor="var(--color-accent-error)"
        collapsed={false}
        summary="the-summary"
        onToggle={() => {}}
        icon={<i data-slot="icon" />}
        status={<i data-slot="status" />}
        trailing={<i data-slot="trailing" />}
      />,
    );
    const head = container.querySelector('[data-collapsible-header]')!;
    const order = [...head.children].map((c) => c.getAttribute("data-slot") ?? (c.textContent === "the-summary" ? "summary" : c.querySelector("svg") ? "chevron" : "?"));
    expect(order.slice(0, 5)).toEqual(["icon", "summary", "status", "trailing", "chevron"]);
    expect((head as HTMLElement).style.borderLeft, "左边条颜色来自调用方（组件不自己决定语义色）").toContain("3px solid");
  });
});

describe("ExecutionStatus：三态都有可被读屏读到的文本，图标只是视觉锚", () => {
  it("三种状态各给出对应译文，且都不含裸 i18n key", () => {
    const cases: ["running" | "error" | "success", string][] = [
      ["running", DICT["shell.toolRunning"]],
      ["error", DICT["shell.toolFailed"]],
      ["success", DICT["shell.toolSucceeded"]],
    ];
    for (const [state, want] of cases) {
      const { container } = render(<ExecutionStatus state={state} />);
      const node = container.querySelector(`[data-exec-status="${state}"]`)!;
      expect(node, `${state} 态应渲染出对应节点`).toBeTruthy();
      expect(node.textContent).toBe(want);
      expect(node.textContent).not.toContain("shell.");
    }
  });

  it("error/success 的图标标了 aria-hidden，语义由 sr-only 文本承担", () => {
    for (const state of ["error", "success"] as const) {
      const { container } = render(<ExecutionStatus state={state} />);
      const node = container.querySelector(`[data-exec-status="${state}"]`)!;
      expect(node.querySelector("svg")?.getAttribute("aria-hidden"), "图标是装饰，不该被读屏念出来").not.toBeNull();
      expect(node.querySelector(".sr-only")?.textContent, "必须有视觉隐藏文本承担语义").toBeTruthy();
    }
  });
});

describe("防再分叉：两个调用方都必须用共享组件，不得自己内联一份", () => {
  const CONSUMERS = [
    "src/plugins/sessions/message-blocks/renderer/tool-cards.tsx",
    "src/plugins/sessions/goal/renderer/goal-card.tsx",
    // r57 全仓扫描查出的**第三份**逐字副本（此前没人知道它存在）
    "src/plugins/sessions/ask/renderer/ask-question-card.tsx",
  ];
  /** 内联实现的特征签名。
   *  ⚠ 要**两个特征同时命中**才算：单独的 `borderLeft: 3px solid` 太松——
   *  `goal-bar.tsx` 是个状态条，也用了这条样式，但它不是可折叠头（首版就误报了它）。
   *  加上那句 `color-mix(… --color-surface 30% …)` 背景后，签名只匹配这一族容器。 */
  const INLINE_SIGNATURE = /borderLeft:\s*`3px solid[\s\S]{0,220}?color-mix\(in srgb, var\(--color-surface\) 30%/;

  it("判据不空转：两个调用方文件都存在", () => {
    for (const rel of CONSUMERS) {
      expect(existsSync(join(ROOT, rel)), `${rel} 不存在（路径变了？改这份清单）`).toBe(true);
    }
  });

  it("① 两个调用方都 import 了 CollapsibleCardHeader", () => {
    const missing = CONSUMERS.filter((rel) => !readFileSync(join(ROOT, rel), "utf-8").includes("CollapsibleCardHeader"));
    expect(missing, `没用共享组件：${missing.join(", ")}（内联一份就会重演 r41→r52 的漂移）`).toEqual([]);
  });

  it("② 调用方里不得再出现内联实现的特征签名（左边条样式）", () => {
    const back = CONSUMERS.filter((rel) => INLINE_SIGNATURE.test(readFileSync(join(ROOT, rel), "utf-8")));
    expect(back, `又内联了一份可折叠头：${back.join(", ")}（容器样式应只存在于 CollapsibleCardHeader）`).toEqual([]);
  });

  it("③ 全仓扫描：除了共享组件自己，没有别的文件内联这个签名（防止第三份实现冒出来）", () => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        const st = statSync(full);
        if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full); }
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
      }
    };
    for (const base of ["src/plugins", "packages/react/src"]) {
      const root = join(ROOT, base);
      if (existsSync(root)) walk(root);
    }
    const offenders = out
      .filter((f) => !f.endsWith("collapsible-card-header.tsx"))
      .filter((f) => INLINE_SIGNATURE.test(readFileSync(f, "utf-8")))
      .map((f) => relative(ROOT, f));
    expect(offenders, `发现内联的可折叠头实现：\n      ${offenders.join("\n      ")}\n      → 改用 CollapsibleCardHeader（否则语义修复要改 N 处，必漏）`).toEqual([]);
  });
});
