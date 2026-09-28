// @vitest-environment jsdom
// ModelConfigPage 的**能力门控**：哪一轴声明为 false，对应控件就不该渲染。
//
// 为什么值得单独立一个文件：这个组件是 pi / dsh / minimal **三个内核共用**的（各自只填
// `i18nPrefix` 与 `capabilities`），所以"某个内核不该看到的控件却渲染出来了"是
// **共享组件特有的缺陷形态**——它对声明了该能力的内核完全正常，只在另一个内核上错。
// 正向剧本（在 pi 上点一遍）永远撞不到它。
//
// r44 修的实例：「developer role 不兼容」勾选框写的是 `supportsDeveloperRole`，
// 而这个字段**只有 pi 消费**（`src/server/kernel/pi/model/models-config.ts` 的
// `compat.supportsDeveloperRole`），dsh / minimal 都没有消费者——但控件此前无条件渲染，
// 于是它们的模型页上有一个勾了也没任何作用的开关（§7.6 该显式降级却没降级）。
//
// ⚠ 文案中性化与能力门控是**两件不同的事**，都要有：前者管"共享组件里不出现某个内核的
// 专属措辞"（上一轮做的），后者管"没有这一维的内核根本不该看到这个控件"（本轮）。
// 只做前者，dsh 用户会看到一个措辞中性、但对自己毫无作用的开关——那仍然是缺陷。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ModelConfigPage } from "../../../packages/react/src/manager/model-config-page";
import type { KernelModelsCapabilities } from "@my-harness-desktop/shared";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
    i18n: { language: "zh-CN" },
  }),
}));

/** usePluginContext 在 render 期读取的 window.kernel 字段全集（属性访问，不调用）。 */
function stubKernel(): void {
  (window as unknown as { kernel: unknown }).kernel = {
    config: {}, sessions: {}, i18n: {}, fs: {}, git: {}, gitWrite: {}, llm: {}, bus: {}, dialog: {},
    prefs: {}, themes: {}, fonts: {}, kernels: {}, kernelModels: {}, kernelConfig: {},
    models: {}, plugins: {}, kernelExtensions: {}, skills: {}, restart: {},
    configFile: { get: vi.fn(), append: vi.fn(), readBinary: vi.fn(), writeBinary: vi.fn() },
    openFile: vi.fn(), appInfo: { get: vi.fn(), restart: vi.fn() }, notify: { show: vi.fn() },
    window: { isFocused: vi.fn() },
    modelsProbe: { discover: vi.fn(), ping: vi.fn() },
  };
}

function renderPage(capabilities: KernelModelsCapabilities, prefix: string) {
  stubKernel();
  const provider = {
    id: "p1", displayName: "P1", api: "openai-completions",
    baseUrl: "https://api.p1.test/v1", apiKey: "sk-1",
    models: [{ id: "m-a", name: "Model A", contextWindow: 128000, maxTokens: 8192 }],
  };
  return render(
    <ModelConfigPage
      api={{ test: vi.fn() } as never}
      i18nPrefix={prefix}
      capabilities={capabilities}
      config={{ providers: [provider], default: null } as never}
      dirty={false}
      onChange={vi.fn()}
    />,
  );
}

/** 控件是否渲染：按 i18n key 查（mock 的 t 原样返回 key），不依赖译文。 */
function hasControl(container: HTMLElement, key: string): boolean {
  return (container.textContent ?? "").includes(key);
}

/** `reasoning` 那一轴的控件是**裸字面量标签**（不是 k("reasoning")），所以按精确文本查。
 *  ⚠ 首版按 i18n key 查，结果恒 false —— 那是我的假设错了，不是门控坏了。
 *  顺带记录一个**有意为之**的现状：`reasoning` / `contextWindow` / `maxTokens` 这三个
 *  API/schema 字段名在四个语言里都照原样显示（没有 locale 键），而通用 UI 词
 *  （`name`、`devRoleIncompatible`）走 i18n。这是可辩护的策略：用户要拿字段名去对照
 *  服务商文档，翻译反而对不上。所以不按"硬编码英文"处理它们。 */
function hasReasoningControl(container: HTMLElement): boolean {
  // 用锚点查（r45 给受门控的两个控件都加了 data-model-*），不再依赖字面量标签文本
  return !!container.querySelector('[data-model-reasoning] input[type="checkbox"]');
}

describe("ModelConfigPage 能力门控：三个内核同等地位、按声明降级", () => {
  it("reasoning 轴：声明 true 才渲染 reasoning 控件", () => {
    const on = renderPage({ reasoning: true, developerRole: true }, "models");
    expect(hasReasoningControl(on.container as HTMLElement), "reasoning=true 时该控件应在").toBe(true);
    const off = renderPage({ reasoning: false, developerRole: true }, "minimalModels");
    expect(hasReasoningControl(off.container as HTMLElement),
      "reasoning=false 的内核不该看到 reasoning 控件").toBe(false);
  });

  it("★ developerRole 轴：只有声明 true 的内核才渲染该控件（r44 修的缺陷）", () => {
    const on = renderPage({ reasoning: true, developerRole: true }, "models");
    expect(hasControl(on.container as HTMLElement, "models.devRoleIncompatible"),
      "pi 声明了 developerRole:true，控件应在").toBe(true);
    for (const [prefix, label] of [["dshModels", "dsh"], ["minimalModels", "minimal"]] as const) {
      const off = renderPage({ reasoning: label === "dsh" ? true : false, developerRole: false }, prefix);
      expect(hasControl(off.container as HTMLElement, `${prefix}.devRoleIncompatible`),
        `${label} 没有 supportsDeveloperRole 的消费者，不该看到这个勾了也没作用的开关`).toBe(false);
    }
  });

  it("两轴互相独立：关掉一轴不影响另一轴（避免门控写成联动）", () => {
    const a = renderPage({ reasoning: true, developerRole: false }, "models");
    expect(hasReasoningControl(a.container as HTMLElement)).toBe(true);
    expect(hasControl(a.container as HTMLElement, "models.devRoleIncompatible")).toBe(false);
    const b = renderPage({ reasoning: false, developerRole: true }, "models");
    expect(hasReasoningControl(b.container as HTMLElement)).toBe(false);
    expect(hasControl(b.container as HTMLElement, "models.devRoleIncompatible")).toBe(true);
  });

  it("契约层面：capabilities 的两个轴都是**必填**（漏声明编译期就红，不静默当 false）", () => {
    // 这条不是运行时断言，而是把"必填"这个设计决定写成可执行的事实：
    // 若哪天有人把它改成可选，这里的类型检查会立刻失效并被 tsc 抓到（对象字面量缺字段）。
    const full: KernelModelsCapabilities = { reasoning: true, developerRole: true };
    expect(Object.keys(full).sort()).toEqual(["developerRole", "reasoning"]);
    // @ts-expect-error 故意漏一个轴：必填 ⇒ 这行必须编译报错，否则说明被改成可选了
    const partial: KernelModelsCapabilities = { reasoning: true };
    expect(partial).toBeTruthy();
  });
});
