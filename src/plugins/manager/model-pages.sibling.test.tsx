// @vitest-environment jsdom
// 「模型配置页」两侧 wrapper 的**成对断言**(§10.4.1:同族并排看)。
//
//   pi-manager/renderer/models.tsx   api=ctx.kernelModels.pi   i18nPrefix="models"    channel="pi-manager:defaultChanged"
//   dsh-manager/renderer/models.tsx  api=ctx.kernelModels.dsh  i18nPrefix="dshModels" channel="dsh-manager:defaultChanged"
//
// 两文件结构逐字相同 —— 复制粘贴的四类静默错,每类都不报错、不崩:
//   ① **api 传错内核** → 页面列出**另一个内核**的模型
//   ② **i18nPrefix 传错** → 文案取自另一个命名空间
//   ③ **channel 传错** → 事件发到**对方的频道**,对方管理器的订阅者会响应本侧的默认变更
//   ④ **`modelId: sel.model` 是跨边界改名** → 写成 `sel.modelId` 会静默发出 `undefined`
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

import { ModelManagerPage, channels as piChannels } from "./pi-manager/renderer/models";
import { DshModelsPage, channels as dshChannels } from "./dsh-manager/renderer/models";

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

  it("③ 事件频道各归各的(发到对方频道会让对方订阅者误响应)", () => {
    expect(piChannels[0]).toBe("pi-manager:defaultChanged");
    expect(dshChannels[0], "dsh 侧用了 pi 的频道名").toBe("dsh-manager:defaultChanged");
  });

  it("④ onDefaultChanged:modelId 由 sel.model **改名**而来(写成 sel.modelId 会发出 undefined)", () => {
    const { unmount } = render(<ModelManagerPage {...props()} />);
    (h.lastProps.onDefaultChanged as (s: { provider: string; model: string }) => void)({ provider: "p1", model: "m1" });
    expect(h.emitted, "默认变更没有发事件").toEqual([["pi-manager:defaultChanged", { provider: "p1", modelId: "m1" }]]);
    unmount();

    h.emitted = [];
    render(<DshModelsPage {...props()} />);
    (h.lastProps.onDefaultChanged as (s: { provider: string; model: string }) => void)({ provider: "p2", model: "m2" });
    expect(h.emitted).toEqual([["dsh-manager:defaultChanged", { provider: "p2", modelId: "m2" }]]);
  });

  it("⑤ dirty 缺省视为 false(两侧一致)", () => {
    const { unmount } = render(<ModelManagerPage {...props()} />);
    expect(page().getAttribute("data-dirty")).toBe("false");
    unmount();

    render(<DshModelsPage {...props()} />);
    expect(page().getAttribute("data-dirty")).toBe("false");
  });
});
