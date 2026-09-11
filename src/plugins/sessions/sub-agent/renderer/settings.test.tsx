// @vitest-environment jsdom
// SubAgentSettings 的 DOM 断言 —— 钉住三处**静默可坏**的语义(该插件此前零 e2e、零单测):
//   ① **默认值** `?? 5` / `?? 10`:缺配置时回落的档位。改掉不报错,只静默改变子代理的并发/超时行为。
//   ② **合并写回** `onChange({ ...config, [key]: value })`:漏掉 `...config` 会把**另一个键**丢掉。
//   ③ **边界声明** `min`/`max`(1–20 / 1–120):被拿掉不报错,只是输入框允许越界值。
//
// 替身必须满足**真实类型** `SettingsComponentProps`(本仓基线 typecheck 0):
// `refreshSignal` 必填;`config` 是 `Record<string, unknown> | null` —— **不能传 `undefined`**。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section><h3>{title}</h3>{children}</section>
  ),
}));

import { SubAgentSettings } from "./settings";

const props = (config: Record<string, unknown> | null, onChange: (c: Record<string, unknown>) => void) =>
  ({ refreshSignal: 0, config, onChange });

const inputs = (): HTMLInputElement[] => screen.getAllByRole("spinbutton") as HTMLInputElement[];

describe("SubAgentSettings(守护参数)", () => {
  it("缺配置时用默认档:并发 5、超时 10", () => {
    render(<SubAgentSettings {...props(null, () => {})} />);
    expect(inputs()[0].value, "并发默认值变了").toBe("5");
    expect(inputs()[1].value, "超时默认值变了").toBe("10");
  });

  it("有配置时按配置回显(不回落默认)", () => {
    render(<SubAgentSettings {...props({ maxConcurrent: 8, timeoutMinutes: 30 }, () => {})} />);
    expect(inputs()[0].value).toBe("8");
    expect(inputs()[1].value).toBe("30");
  });

  it("改一个键时**合并**写回:另一个键不被丢掉", () => {
    const onChange = vi.fn();
    render(<SubAgentSettings {...props({ maxConcurrent: 8, timeoutMinutes: 30 }, onChange)} />);
    fireEvent.change(inputs()[0], { target: { value: "9" } });
    expect(onChange).toHaveBeenCalledWith({ maxConcurrent: 9, timeoutMinutes: 30 });
  });

  it("边界声明在:并发 1–20、超时 1–120", () => {
    render(<SubAgentSettings {...props(null, () => {})} />);
    const [a, b] = inputs();
    expect([a.min, a.max], "并发边界声明被拿掉").toEqual(["1", "20"]);
    expect([b.min, b.max], "超时边界声明被拿掉").toEqual(["1", "120"]);
  });

  it("缺配置时修改:以空对象为底,不抛错", () => {
    const onChange = vi.fn();
    render(<SubAgentSettings {...props(null, onChange)} />);
    fireEvent.change(inputs()[1], { target: { value: "15" } });
    expect(onChange).toHaveBeenCalledWith({ timeoutMinutes: 15 });
  });
});
