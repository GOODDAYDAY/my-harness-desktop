// @vitest-environment jsdom
// 原位两步确认原语：`InlineConfirmInput` 与 `useArmConfirm`（r161；此前零测试引用）。
//
// ## 为什么这一族值得测
//
// 它是 `window.confirm` / 遮罩弹窗的**统一替代**（文件头写明：任何需要二次确认的动作，
// 第一步在触发点、第二步在触发点原位变换；全程无遮罩、无原生 dialog、焦点不离开上下文），
// 由 retry / fork / bookmark 四处同构消费收敛而来（§3.3）。
// 所以它的每个边界都是**四个消费方共享**的边界：
//   · 空值/纯空白**不许确认**（否则会用空名字重命名、空路径分叉）；
//   · blur 的 `relatedTarget` 判断（焦点从输入框移到 ✓/✗ 按钮时**不能**当成"放弃"，
//     否则点确认按钮的前一刻就取消了 —— 与 r155 修 PanelRow 时那条边界同族）；
//   · `useArmConfirm` 的超时与 Esc 复位（武装态卡住 = 按钮永远显示"确认?"）。
//
// ⚠ 框架组件**零文案**（§1.2）：title 由消费方 i18n 供，所以本测试自己传 title 并断言
//   可访问名来自它 —— 顺带钉住"框架不内嵌文案"这条性质。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { InlineConfirmInput, useArmConfirm } from "./inline-confirm";

/** useArmConfirm 是 hook，需要一个宿主组件才能驱动（不引入 renderHook 依赖）。 */
function ArmHost<T>({ timeoutMs, onState }: { timeoutMs?: number; onState: (armed: T | null, api: { arm: (v: T) => void; disarm: () => void }) => void }): React.ReactNode {
  const { armed, arm, disarm } = useArmConfirm<T>(timeoutMs);
  onState(armed, { arm, disarm });
  return <span data-armed={armed === null ? "null" : String(armed)} />;
}

describe("InlineConfirmInput：原位输入确认", () => {
  // ⚠ vi.fn() 要给**显式泛型**，否则 ReturnType<typeof vi.fn> 是宽 Mock 类型、
  //   赋给 (value: string) => void 会报 TS2322（r161 实测）。
  let api: { confirm: ReturnType<typeof vi.fn<(v: string) => void>>; cancel: ReturnType<typeof vi.fn<() => void>> };
  beforeEach(() => { api = { confirm: vi.fn<(v: string) => void>(), cancel: vi.fn<() => void>() }; });

  function mount(props: Partial<Parameters<typeof InlineConfirmInput>[0]> = {}) {
    return render(
      <InlineConfirmInput
        onConfirm={api.confirm}
        onCancel={api.cancel}
        confirmTitle="确认"
        cancelTitle="取消"
        {...props}
      />,
    );
  }
  const input = (): HTMLInputElement => screen.getByRole("textbox") as HTMLInputElement;

  it("① 挂载即**聚焦并全选**（Enter 直接确认默认值，零多余击键）", () => {
    mount({ defaultValue: "旧名字" });
    expect(document.activeElement, "autoFocus 是这个原语的核心契约（焦点不离开上下文）").toBe(input());
    expect(input().value).toBe("旧名字");
  });

  it("② Enter ⇒ onConfirm 拿到**去空格后**的值，且不触发 cancel", () => {
    mount({ defaultValue: "  带空格  " });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.confirm).toHaveBeenCalledWith("带空格");
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("③ **空值 / 纯空白 ⇒ 不确认**（否则会用空名字重命名、空路径分叉）", () => {
    mount({ defaultValue: "" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(api.confirm, "空值不该确认").not.toHaveBeenCalled();
    expect(api.cancel, "空值 Enter 也不该被当成取消（用户还在编辑）").not.toHaveBeenCalled();
  });

  it("④ 空值时 ✓ 按钮是 **disabled**；输入内容后解禁（视觉与行为一致）", () => {
    mount({ defaultValue: "" });
    expect(screen.getByTitle("确认"), "空值时不该给一个点了没反应的按钮").toBeDisabled();
    fireEvent.change(input(), { target: { value: "有内容" } });
    expect(screen.getByTitle("确认")).not.toBeDisabled();
  });

  it("⑤ Escape ⇒ onCancel（且不确认）", () => {
    mount({ defaultValue: "x" });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(api.cancel).toHaveBeenCalledTimes(1);
    expect(api.confirm).not.toHaveBeenCalled();
  });

  it("⑥ 点 ✗ ⇒ onCancel；点 ✓ ⇒ onConfirm", () => {
    mount({ defaultValue: "值" });
    fireEvent.click(screen.getByTitle("取消"));
    expect(api.cancel).toHaveBeenCalledTimes(1);
    api.cancel.mockClear();
    fireEvent.click(screen.getByTitle("确认"));
    expect(api.confirm).toHaveBeenCalledWith("值");
  });

  it("⑦ blur **到组外** ⇒ onCancel（点击空白即取消）", () => {
    mount({ defaultValue: "x" });
    fireEvent.blur(input(), { relatedTarget: document.body });
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });

  it("⑧ blur **到组内的 ✓/✗** ⇒ 不取消（relatedTarget 判断；否则点确认的前一刻就取消了）", () => {
    mount({ defaultValue: "x" });
    const ok = screen.getByTitle("确认");
    fireEvent.blur(input(), { relatedTarget: ok });
    expect(api.cancel, "焦点移到组内按钮不是放弃（与 r155 PanelRow 同族边界）").not.toHaveBeenCalled();
  });

  it("⑨ 可访问名来自消费方传入的 title（框架零文案，§1.2）", () => {
    mount({ confirmTitle: "保存改名", cancelTitle: "放弃改名" });
    expect(screen.getByRole("button", { name: "保存改名" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放弃改名" })).toBeInTheDocument();
  });

  it("⑩ 打字即覆盖默认值（受控），确认拿到的是最新值", () => {
    mount({ defaultValue: "旧" });
    fireEvent.change(input(), { target: { value: "新" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(api.confirm).toHaveBeenCalledWith("新");
  });
});

describe("useArmConfirm：武装两步确认状态机", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function host<T>(timeoutMs?: number) {
    let latest: { armed: T | null; arm: (v: T) => void; disarm: () => void } = {
      armed: null, arm: () => {}, disarm: () => {},
    };
    const utils = render(
      <ArmHost<T> timeoutMs={timeoutMs} onState={(armed, api) => { latest = { armed, ...api }; }} />,
    );
    const read = (): string => utils.container.querySelector("[data-armed]")!.getAttribute("data-armed")!;
    return { ...utils, latest: () => latest, read };
  }

  it("① 初始未武装；arm(v) ⇒ armed === v（泛型：布尔与行 id 两种用法）", () => {
    const h = host<string>();
    expect(h.read()).toBe("null");
    act(() => { h.latest().arm("row-3"); });
    expect(h.read(), "同面板多行场景用行 id 作武装值").toBe("row-3");
  });

  it("② Esc（document 级）⇒ 复位（武装态卡住 = 按钮永远显示『确认?』）", () => {
    const h = host<boolean>();
    act(() => { h.latest().arm(true); });
    expect(h.read()).toBe("true");
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(h.read(), "Esc 必须复位").toBe("null");
  });

  it("③ 超时 ⇒ 自动复位（默认 6000ms；用户走开后按钮不该一直停在确认态）", () => {
    const h = host<boolean>(6000);
    act(() => { h.latest().arm(true); });
    act(() => { vi.advanceTimersByTime(5999); });
    expect(h.read(), "未到点不复位").toBe("true");
    act(() => { vi.advanceTimersByTime(1); });
    expect(h.read(), "到点复位").toBe("null");
  });

  it("④ disarm() ⇒ 立即复位（执行完动作后消费方自己收）", () => {
    const h = host<boolean>();
    act(() => { h.latest().arm(true); });
    act(() => { h.latest().disarm(); });
    expect(h.read()).toBe("null");
  });

  it("⑤ 复位后**清掉定时器与 keydown 监听**（否则每次武装都多挂一个监听）", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const h = host<boolean>(6000);
    act(() => { h.latest().arm(true); });
    act(() => { vi.advanceTimersByTime(6000); });
    expect(removeSpy.mock.calls.some((c) => c[0] === "keydown"),
      "复位时应移除 document 的 keydown 监听（useEffect 清理函数）").toBe(true);
    // 复位后再按 Esc 不该影响状态（监听已摘）
    const before = h.read();
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(h.read()).toBe(before);
    removeSpy.mockRestore();
  });

  it("⑥ 未武装时不挂监听（armed === null 直接 return，不建定时器）", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    host<boolean>();
    expect(addSpy.mock.calls.some((c) => c[0] === "keydown"),
      "未武装时不该挂 document keydown（否则每个用这个 hook 的组件都常驻一个全局监听）").toBe(false);
    addSpy.mockRestore();
  });
});
