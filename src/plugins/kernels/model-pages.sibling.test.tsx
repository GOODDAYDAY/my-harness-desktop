// @vitest-environment jsdom
// 「模型配置页」两侧 wrapper 的**成对断言**(§10.4.1:同族并排看)。
//
//   kernels/pi/renderer/models.tsx   api=ctx.kernelModels.pi   i18nPrefix="models"
//   kernels/dsh/renderer/models.tsx  api=ctx.kernelModels.dsh  i18nPrefix="dshModels"
//
// 两文件结构逐字相同 —— 复制粘贴的静默错,每类都不报错、不崩:
//   ① **api 传错内核** → 页面列出**另一个内核**的模型
//   ② **i18nPrefix 传错** → 文案取自另一个命名空间
//   ③ **私有频道回潮** → 见下方 ③（契约已改：内核管理页不再声明任何插件私有频道）
//
// 本文件原住在 src/plugins/manager/ 下（那时内核管理面是独立插件）；
// 内核对接面并入内核插件目录后，它作为**内核组的成对断言**留在 kernels/ 组目录。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SettingsComponentProps } from "@my-harness-desktop/react";

const h = vi.hoisted(() => ({ emitted: [] as unknown[][], lastProps: {} as Record<string, unknown> }));
vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({
    kernelModels: { pi: { id: "API_PI" }, dsh: { id: "API_DSH" } },
    events: { emit: (...a: unknown[]) => { h.emitted.push(a); } },
  }),
  // 探针:既把 props 变成可断言的属性,也捕获它们(用于触发 onDefaultChanged)
  ModelConfigPage: (p: Record<string, unknown>) => {
    h.lastProps = p;
    return (
      <div
        data-testid="page"
        data-api={(p.api as { id: string }).id}
        data-prefix={String(p.i18nPrefix)}
        data-dirty={String(p.dirty)}
      />
    );
  },
}));

import * as piEntry from "./pi/renderer/models";
import * as dshEntry from "./dsh/renderer/models";
const { ModelManagerPage } = piEntry;
const { DshModelsPage } = dshEntry;

const props = (over: Partial<SettingsComponentProps> = {}): SettingsComponentProps =>
  ({ refreshSignal: 0, config: null, onChange: () => {}, ...over });
const page = () => screen.getByTestId("page");
vi.mock("@my-harness-desktop/react", async () => {
  const actual = { usePluginContext: () => ({ kernelModels: { pi: { id: "API_PI" }, dsh: { id: "API_DSH" } }, events: { emit: (...a: unknown[]) => { h.emitted.push(a); } } }) };
  return {
    ...actual,
    ModelConfigPage: (p: Record<string, unknown>) => {
      h.lastProps = p;
      return <div data-testid="page" data-api={(p.api as { id: string }).id} data-prefix={String(p.i18nPrefix)} data-dirty={String(p.dirty)} />;
    },
  };
});

beforeEach(() => { h.emitted = []; h.lastProps = {}; });

describe("模型配置页 wrapper 对(内核身份/文案/频道必须各归各的)", () => {
  it("① api 各传自己的内核模型面(传错会列出另一内核的模型)", () => {
    const { unmount } = render(<ModelManagerPage {...props()} />);
    expect(page().getAttribute("data-api")).toBe("API_PI");
    unmount();

    render(<DshModelsPage {...props()} />);
    expect(page().getAttribute("data-api"), "dsh 模型页拿了别的内核的模型面").toBe("API_DSH");
  });

  it("② i18nPrefix 各取自己的命名空间", () => {
    const { unmount } = render(<ModelManagerPage {...props()} />);
    expect(page().getAttribute("data-prefix")).toBe("models");
    unmount();

    render(<DshModelsPage {...props()} />);
    expect(page().getAttribute("data-prefix"), "dsh 侧用了 pi 的文案前缀").toBe("dshModels");
  });

  // ③ 契约已改（勿回退）：默认模型变更**不再走插件私有频道**。
  // 此前这里断言两侧各自的 `<内核名>-manager:defaultChanged`，而那个频道的消费方是 timeline ——
  // 等于让 timeline 硬编码另一个插件的 id（违反 §8.3 零硬编码），且每个内核各占一个频道。
  // 现在统一走 main 侧广播的中性信号 system:refreshRequested（controllers/kernel.ts 的
  // kernelModels.setDefault handler），所以内核管理页**不该再声明任何 channels**。
  it("③ 不声明插件私有频道（默认模型变更走框架中性信号，插件之间不认彼此 id）", () => {
    expect("channels" in piEntry, "pi 内核管理页又声明了私有频道——会把别的插件 id 焊进消费方").toBe(false);
    expect("channels" in dshEntry, "dsh 内核管理页又声明了私有频道").toBe(false);
  });

  it("④ 不再透传 onDefaultChanged（回调位随私有频道一起退役）", () => {
    const { unmount } = render(<ModelManagerPage {...props()} />);
    expect(h.lastProps.onDefaultChanged, "pi 侧又把 onDefaultChanged 接回事件总线了").toBeUndefined();
    unmount();
    render(<DshModelsPage {...props()} />);
    expect(h.lastProps.onDefaultChanged, "dsh 侧又把 onDefaultChanged 接回事件总线了").toBeUndefined();
  });

  it("⑤ dirty 缺省视为 false(两侧一致)", () => {
    const { unmount } = render(<ModelManagerPage {...props()} />);
    expect(page().getAttribute("data-dirty")).toBe("false");
    unmount();

    render(<DshModelsPage {...props()} />);
    expect(page().getAttribute("data-dirty")).toBe("false");
  });
});
