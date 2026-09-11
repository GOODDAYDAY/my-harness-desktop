// @vitest-environment jsdom
// notifier Overlay 的 DOM/行为断言 —— 该文件第 4 行写明**四道闸判定链**:
//   `enabled → isFocused → 冷却(节流) → notify.show`
// 本测试逐闸钉住,重点是第 3 闸那条精确契约:
//   「节流(**固定窗口**),不是去抖:**只在真正弹时更新时间戳**,判定被拦不更新」
// —— 把"更新时间戳"提到判定之前不报错,只会让**被抑制的那次也吃掉冷却窗口**(静默改变语义)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

// 捕获组件注册的事件回调,并记录 ctx 调用
const h = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  focused: true,
  onKernelEvent: null as null | ((ev: unknown) => void),
  show: [] as unknown[],
  showImpl: null as null | (() => Promise<void>),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({
    sessions: { onKernelEvent: (cb: (ev: unknown) => void) => { h.onKernelEvent = cb; return () => {}; } },
    window: { isFocused: async () => h.focused },
    notify: { show: async (n: unknown) => { h.show.push(n); if (h.showImpl) await h.showImpl(); } },
  }),
  useUiStore: { getState: () => ({ generalConfig: h.cfg }) },
}));

import { Overlay } from "./index";

const settled = { kind: "session", event: { type: "agentSettled" } };
/** 触发一次 agentSettled 并等异步判定链走完(isFocused 是 await 的)。 */
const fire = async (ev: unknown = settled): Promise<void> => {
  await act(async () => { h.onKernelEvent!(ev); await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => { h.cfg = {}; h.focused = true; h.show = []; h.showImpl = null; });

describe("notifier Overlay(四道闸判定链)", () => {
  it("第 0 闸:非 session 事件 / 非 agentSettled 一律不通知", async () => {
    render(<Overlay />);
    h.focused = false;
    await fire({ kind: "other", event: { type: "agentSettled" } });
    await fire({ kind: "session", event: { type: "other" } });
    expect(h.show, "无关事件触发了通知").toEqual([]);
  });

  it("第 1 闸:enabled 只有显式 false 才关(缺省视为开)", async () => {
    render(<Overlay />);
    h.focused = false;
    await fire();
    expect(h.show.length, "缺省 enabled 时没有通知").toBe(1);

    h.cfg = { "notifier.enabled": false };
    await fire();
    expect(h.show.length, "enabled:false 仍发了通知").toBe(1);
  });

  it("第 2 闸:窗口在前台时不打扰(用户正看着)", async () => {
    render(<Overlay />);
    h.focused = true;
    await fire();
    expect(h.show, "窗口前台仍弹了通知").toEqual([]);
  });

  it("第 3 闸(节流):被抑制的那次**不吃冷却窗口**(时间戳只在真正弹时更新)", async () => {
    render(<Overlay />);
    h.focused = true;
    await fire();                       // 前台 → 被第 2 闸拦下
    h.focused = false;
    await fire();                       // 立刻再触发:若时间戳在拦截前被更新过,这里会被冷却挡掉
    expect(h.show.length, "被抑制的一次吃掉了冷却窗口(时间戳更新时机不对)").toBe(1);
  });

  it("第 3 闸:真正弹过之后,冷却期内不再弹", async () => {
    render(<Overlay />);
    h.focused = false;
    await fire();
    await fire();                       // 冷却默认 3s,立即再触发应被挡
    expect(h.show.length).toBe(1);
  });

  it("第 3 闸:cooldownSec 非法值(0/负/非数)回退默认 3s", async () => {
    render(<Overlay />);
    h.focused = false;
    h.cfg = { "notifier.cooldownSec": 0 };     // 非正 → 回退 3s(不是"冷却 0ms")
    await fire();
    await fire();
    expect(h.show.length, "cooldownSec=0 时未回退默认,冷却被绕过").toBe(1);
  });

  it("notify.show 抛错不致命(环境不支持时静默)", async () => {
    render(<Overlay />);
    h.focused = false;
    h.showImpl = async () => { throw new Error("no notification support"); };
    await expect(fire()).resolves.toBeUndefined();
    expect(h.show.length).toBe(1);              // 已尝试
  });
});
