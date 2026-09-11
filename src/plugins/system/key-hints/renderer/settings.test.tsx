// @vitest-environment jsdom
// KeyHintsSettings 的 DOM 断言 —— 钉住两处**静默可坏**的语义(该插件此前零 e2e、零单测):
//   ① 第 14 行 `config?.backquote !== false` —— **只有显式 false 才关**,即"默认开"。
//      写成 `=== true` 不报错,只会把默认从"开"翻成"关"(用户体验静默改变)。
//   ② 第 30 行 `onChange({ ...(config ?? {}), backquote })` —— **合并**写回。
//      漏掉 `...config` 不报错,只会把配置里**同族的其它键整段丢掉**。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// SettingsSection 是框架提供的框壳:原样透传 title/description/children(断言关心的是控件与回调)
vi.mock("@my-harness-desktop/react", () => ({
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section><h3>{title}</h3>{children}</section>
  ),
}));

import { KeyHintsSettings } from "./settings";

// 替身必须满足**真实类型**(本仓基线是 typecheck 0):`refreshSignal` 必填、`config` 是
// `Record<string, unknown> | null`——**不能传 `undefined`**。"配置缺失"在这里的正确表达是 `null`。
const props = (config: Record<string, unknown> | null, onChange: (c: Record<string, unknown>) => void) =>
  ({ refreshSignal: 0, config, onChange });

describe("KeyHintsSettings(` 前缀键开关)", () => {
  it("配置缺失时开关**默认开**(契约是 `!== false`,不是 `=== true`)", () => {
    render(<KeyHintsSettings {...props(null, () => {})} />);
    expect(screen.getByRole("checkbox"), "缺配置时开关没默认打开").toBeChecked();
  });

  it("显式 false 时关;显式 true 时开", () => {
    const { unmount } = render(<KeyHintsSettings {...props({ backquote: false }, () => {})} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    unmount();
    render(<KeyHintsSettings {...props({ backquote: true }, () => {})} />);
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("切换时**合并**写回:保留配置里的其它键", () => {
    const onChange = vi.fn();
    render(<KeyHintsSettings {...props({ backquote: true, otherKey: "keep-me" }, onChange)} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith({ backquote: false, otherKey: "keep-me" });
  });

  it("配置缺失时切换:以空对象为底,不抛错", () => {
    const onChange = vi.fn();
    render(<KeyHintsSettings {...props(null, onChange)} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith({ backquote: false });
  });
});
