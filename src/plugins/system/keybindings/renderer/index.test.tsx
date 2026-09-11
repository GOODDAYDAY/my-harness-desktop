// @vitest-environment jsdom
// keybindings Overlay 的**交互**断言 —— 它的分发链是纯客户端键盘逻辑,jsdom 能真跑:
//   keydown → comboFromEvent → 命中 binding → **shouldFire 守卫** → preventDefault + invoke
// 钉住的契约(其中 ②③ 来自 core/bindings.ts 里文档化的"输入态守卫"):
//   ① 纯键在**非输入态**触发
//   ② 纯键在**输入态不触发**(smart:不抢用户在输入框里的按键)
//   ③ `when:"always"` 无条件触发(拦截输入自担)
//   ④ 带**强修饰键**(ctrl/meta/alt/mod)在输入态**也触发**(smart 的例外)
//   ⑤ 没命中绑定 → 不触发 **且不 preventDefault**
//   ⑥ 触发时才 preventDefault(否则会吃掉无关按键)
//
// 做法:DEFAULT_BINDINGS 是常量,mock 成受控列表 → 事件与组合键一一对应,
// 不依赖平台 mod 映射(darwin→meta / 其它→ctrl 的不确定性)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  invoked: [] as unknown[][],
  saved: null as null | (() => void),
}));

vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({
    config: { get: async () => undefined },
    events: {
      on: (_ch: string, cb: () => void) => { h.saved = cb; return () => {}; },
      invoke: (...a: unknown[]) => { h.invoked.push(a); },
    },
  }),
}));
// 受控绑定列表:一条纯键、一条强修饰键、一条 always
vi.mock("../core/bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/bindings")>();
  return {
    ...actual,
    DEFAULT_BINDINGS: [
      { combo: "f2", channel: "t:plain" },
      { combo: "ctrl+f3", channel: "t:strong" },
      { combo: "f4", channel: "t:always", when: "always" as const },
    ],
  };
});

import { Overlay } from "./index";

const press = (opts: Record<string, unknown>, target?: Element | Document | Window): void => {
  act(() => { fireEvent.keyDown(target ?? document.body, opts); });
};
const input = (): HTMLInputElement => {
  const el = document.createElement("input");
  document.body.appendChild(el);
  el.focus();
  return el;
};

beforeEach(() => { h.invoked = []; document.body.innerHTML = ""; });

describe("keybindings Overlay(快捷键分发 + 输入态守卫)", () => {
  it("① 纯键在非输入态触发", () => {
    render(<Overlay />);
    press({ key: "F2" });
    expect(h.invoked).toEqual([["t:plain", undefined]]);
  });

  it("② 纯键在**输入态不触发**(smart 守卫)", () => {
    render(<Overlay />);
    const el = input();
    press({ key: "F2" }, el);
    expect(h.invoked, "输入框里按纯键被抢走了").toEqual([]);
  });

  it("③ when:always 在输入态也触发", () => {
    render(<Overlay />);
    const el = input();
    press({ key: "F4" }, el);
    expect(h.invoked).toEqual([["t:always", undefined]]);
  });

  it("④ 带强修饰键(ctrl)在输入态**也**触发", () => {
    render(<Overlay />);
    const el = input();
    press({ key: "F3", ctrlKey: true }, el);
    expect(h.invoked, "强修饰键在输入态被错误拦下").toEqual([["t:strong", undefined]]);
  });

  it("⑤ 未命中绑定:不触发且**不** preventDefault", () => {
    render(<Overlay />);
    const ev = new KeyboardEvent("keydown", { key: "F9", bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(ev); });
    expect(h.invoked).toEqual([]);
    expect(ev.defaultPrevented, "无关按键被 preventDefault 吃掉了").toBe(false);
  });

  it("⑥ 命中并触发时才 preventDefault", () => {
    render(<Overlay />);
    const ev = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(ev); });
    expect(h.invoked.length).toBe(1);
    expect(ev.defaultPrevented, "触发时未阻止默认行为").toBe(true);
  });
});
