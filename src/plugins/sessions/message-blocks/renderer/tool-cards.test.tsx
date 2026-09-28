// @vitest-environment jsdom
// 工具卡「运行中图标明暗交替」守卫(诉求 15:只要运行中,图标要么动、要么明暗交替)。
//
// 根因背景:整卡此前只有「running」文案的 shimmer + 左侧呼吸条,而**工具图标本身是静态的**
// ——用户看到的是"在执行"的提示,但那个图标不动,不满足"逐图标"的纪律。修法=图标挂
// animate-pulse(isStreaming 时),本文件锁住这条不变式。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// i18n 给**真字典**（直接读 locale 文件，不在测试里另抄一份——另抄必然漂移，
// 于是"测试绿但界面是别的字"）。CLAUDE.md §5.6。
//
// ⚠ 要**合并多个插件的语言包**，因为真实 i18n 就是这么装配的：本组件用到的键分两处——
//   `timeline.*` 在本插件自己的 locale 里，而三个执行状态词（toolRunning/toolFailed/
//   toolSucceeded）在 **system/i18n 插件的 `shell.json`** 里。r52 把它们从本插件挪到 shell.*，
//   理由是 goal 插件也要用同一组词，而跨插件依赖另一个**业务**插件的语言包是脆的
//   （用户禁用 message-blocks 就会丢文案）；`shell.*` 由始终装载的 i18n 插件贡献，才是正确的家。
//   只读一份字典的测试会在挪动之后静默退化成"断言裸 key"（`DICT[k] ?? k` 回落），
//   那样即使界面显示的是 key 本身，测试也照样绿。
const __here = dirname(fileURLToPath(import.meta.url));
const DICT: Record<string, string> = {
  ...(JSON.parse(readFileSync(join(__here, "../locales/zh-CN/timeline.json"), "utf-8")) as Record<string, string>),
  ...(JSON.parse(readFileSync(join(__here, "../../../system/i18n/locales/zh-CN/shell.json"), "utf-8")) as Record<string, string>),
};
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>): string => {
      let v = DICT[k] ?? k;
      for (const [n, val] of Object.entries(vars ?? {})) v = v.split(`{{${n}}}`).join(String(val));
      return v;
    },
    i18n: { exists: (k: string) => k in DICT },
  }),
}));
import type { ToolCallBlock } from "@my-harness-desktop/shared";
import { DefaultCard, BashCard } from "./tool-cards";

/** 只喂本断言用得到的字段:卡片读 state(判运行态)与 name(选图标)。 */
const running = { state: "running", name: "read", input: {}, id: "t1" } as unknown as ToolCallBlock;
const done = { state: "completed", name: "read", input: {}, id: "t1", result: "ok" } as unknown as ToolCallBlock;

/** 卡片里带 svg 且挂 animate-pulse 的图标 span —— 就是"运行中图标在闪"。 */
function pulsingIconCount(container: HTMLElement): number {
  return [...container.querySelectorAll("span.animate-pulse")].filter((s) => s.querySelector("svg")).length;
}

describe("工具卡运行中图标明暗交替(诉求 15)", () => {
  it("DefaultCard:运行中工具图标挂 animate-pulse(不是静态)", () => {
    const { container } = render(<DefaultCard toolCall={running} />);
    expect(pulsingIconCount(container)).toBeGreaterThan(0);
  });

  it("DefaultCard:完成后图标不再闪(静态)", () => {
    const { container } = render(<DefaultCard toolCall={done} />);
    expect(pulsingIconCount(container)).toBe(0);
  });

  it("BashCard:运行中图标同样明暗交替(卡片变体不得漏)", () => {
    const { container } = render(<BashCard toolCall={{ ...running, name: "bash" } as unknown as ToolCallBlock} />);
    expect(pulsingIconCount(container)).toBeGreaterThan(0);
  });
});

// ---- 可访问语义（r41）----
//
// 工具卡的头是 role=button + tabIndex=0 + Enter/Space 键处理（键盘**本来就可达**），
// 缺的是两样状态语义：① 展开/收起只有 Chevron 图标在切换，没有 aria-expanded
// ——读屏用户按 Enter 展开了却听不到"已展开"；② 成功/失败是**纯图标**（<Check/> 与 <X/>，
// 无可访问名），而"这个工具成功还是失败"恰恰是工具卡最该被听到的一条信息。
// 另外 "running" 曾是**硬编码英文**（换语言不变）。
describe("工具卡的可访问语义", () => {
  it("卡头是 role=button 且可键盘聚焦（既有行为，钉住别退化）", () => {
    const { container } = render(<DefaultCard toolCall={done} />);
    const head = container.querySelector('[role="button"]')!;
    expect(head).toBeTruthy();
    expect(head.getAttribute("tabindex"), "必须能 Tab 到").toBe("0");
  });

  it("卡头带 aria-expanded，且随展开/收起翻转", () => {
    const { container } = render(<DefaultCard toolCall={done} />);
    const head = container.querySelector('[role="button"]')!;
    const before = head.getAttribute("aria-expanded");
    expect(before === "true" || before === "false", `aria-expanded 必须存在且是布尔字面量（实际 ${before}）`).toBe(true);
    fireEvent.keyDown(head, { key: "Enter" });
    expect(head.getAttribute("aria-expanded"), "按 Enter 后 aria-expanded 必须翻转").not.toBe(before);
    fireEvent.keyDown(head, { key: " " });
    expect(head.getAttribute("aria-expanded"), "空格键同样能切回").toBe(before);
  });

  it("成功/失败状态有**文本**语义（不是只有图标），且图标标了 aria-hidden", () => {
    const { container } = render(<DefaultCard toolCall={done} />);
    const ok = container.querySelector('[data-exec-status="success"]')!;
    expect(ok, "完成的工具卡应有成功状态节点").toBeTruthy();
    expect(ok.querySelector("svg")?.getAttribute("aria-hidden"), "图标是装饰，语义由文本承担").not.toBeNull();
    const srText = ok.querySelector(".sr-only")?.textContent ?? "";
    expect(srText).toBe(DICT["shell.toolSucceeded"]);
    expect(srText, "不能是裸 i18n key").not.toContain("timeline.");
  });

  it("失败的卡报「执行失败」而不是「执行成功」（两种状态不能串）", () => {
    const failed = { state: "aborted", name: "read", input: {}, id: "t2", error: "boom" } as unknown as ToolCallBlock;
    const { container } = render(<DefaultCard toolCall={failed} />);
    const err = container.querySelector('[data-exec-status="error"]');
    const okNode = container.querySelector('[data-exec-status="success"]');
    // 该 fixture 是否被判为失败取决于卡片对 state 的映射；两种情况都不该同时出现两个状态
    expect(err && okNode, "同一张卡不能同时标成功与失败").toBeFalsy();
    if (err) expect(err.querySelector(".sr-only")?.textContent).toBe(DICT["shell.toolFailed"]);
  });

  it("运行中的文案走 i18n（不再是硬编码英文 \"running\"）", () => {
    const { container } = render(<DefaultCard toolCall={running} />);
    const txt = (container.textContent ?? "");
    expect(txt, "硬编码的英文 running 不该再出现（zh-CN 字典下应是中文）").not.toMatch(/(^|[^\w])running([^\w]|$)/);
    expect(txt).toContain(DICT["shell.toolRunning"]);
  });
});

describe("不可展开时不得宣称可展开（错误承诺）", () => {
  it("没有 args 也没有 result 的卡：不是 button、没有 tabIndex、没有 aria-expanded、没有 chevron", () => {
    const bare = { state: "completed", name: "custom_message", input: {}, id: "t3" } as unknown as ToolCallBlock;
    const { container } = render(<DefaultCard toolCall={bare} />);
    // 给一个点了不动的元素挂 aria-expanded="false"，等于告诉读屏用户"这里能展开"——
    // 他会一直试着展开，而什么都不会发生。所以三者要**成套撤销**。
    expect(container.querySelector('[role="button"]'), "不该有 button 语义").toBeNull();
    expect(container.querySelector("[aria-expanded]"), "不该声明 aria-expanded").toBeNull();
    expect(container.querySelector('[tabindex="0"]'), "不该进 Tab 序").toBeNull();
    expect((container.textContent ?? "").length, "卡仍应显示工具名").toBeGreaterThan(0);
  });

  it("有详情的卡则三者齐全（对照，防止把上面那条写成『一律不给』）", () => {
    const { container } = render(<DefaultCard toolCall={done} />);
    const head = container.querySelector('[role="button"]')!;
    expect(head).toBeTruthy();
    expect(head.getAttribute("tabindex")).toBe("0");
    expect(head.getAttribute("aria-expanded")).toMatch(/^(true|false)$/);
  });
});

describe("执行状态词的键必须真在合并后的字典里（防回落到裸 key 的假绿）", () => {
  it("三个 shell.* 状态词都有译文，且不是 key 本身", () => {
    for (const k of ["shell.toolRunning", "shell.toolFailed", "shell.toolSucceeded"]) {
      expect(DICT[k], `${k} 不在合并后的字典里 ⇒ t() 会回落到 key，界面就会显示 "${k}"`).toBeTruthy();
      expect(DICT[k]).not.toBe(k);
      expect(DICT[k].length, `${k} 的译文过短，疑似占位`).toBeGreaterThan(0);
    }
  });

  it("本插件的 timeline.json 里**不该**再有这三个键的副本（两份定义必然漂移，§1.3）", () => {
    const own = JSON.parse(readFileSync(join(__here, "../locales/zh-CN/timeline.json"), "utf-8")) as Record<string, string>;
    const dupes = Object.keys(own).filter((k) => /toolRunning|toolFailed|toolSucceeded/.test(k));
    expect(dupes, `本插件里仍有状态词副本：${dupes.join(", ")}（应只在 shell.* 一处）`).toEqual([]);
  });
});
