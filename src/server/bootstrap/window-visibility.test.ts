// 窗口可见性策略的守卫测试(§3.7 根因修复必须留守卫)。
//
// 守的是什么:测试/自动化拉起 app 时**不得抢用户焦点**。
// 根因是 electron.ts 里无条件的 `win.show()`——每次 e2e 都把用户正在用的窗口顶掉。
// 这条守卫钉住"MHD_WINDOW=hidden ⇒ 不 show / 不可聚焦 / 不弹系统通知",
// 让将来任何一次"顺手把 show 改回来"或"新增一个可见性开关"在单测层就被拦住。
import { describe, it, expect } from "vitest";
import { windowVisibilityPolicy } from "./window-visibility";

describe("windowVisibilityPolicy", () => {
  it("未设 MHD_WINDOW：按 shown 走，dev/生产行为一字不变", () => {
    const p = windowVisibilityPolicy({});
    expect(p.show).toBe(true);
    expect(p.focusable).toBe(true);
    expect(p.nativeAlerts).toBe(true);
  });

  it("MHD_WINDOW=hidden：不 show、不可聚焦、不露任务栏、不弹系统通知", () => {
    const p = windowVisibilityPolicy({ MHD_WINDOW: "hidden" });
    expect(p.show).toBe(false);
    expect(p.focusable).toBe(false);
    expect(p.skipTaskbar).toBe(true);
    expect(p.nativeAlerts).toBe(false);
    expect(p.dockIcon).toBe(false);
  });

  it("静默态必须关掉后台节流：窗口不可见时定时器降频会让长回合 e2e 假失败", () => {
    expect(windowVisibilityPolicy({ MHD_WINDOW: "hidden" }).backgroundThrottling).toBe(false);
    expect(windowVisibilityPolicy({ MHD_WINDOW: "shown" }).backgroundThrottling).toBe(true);
  });

  it("MHD_WINDOW=shown：显式要求看窗口时回到可见态(人工观察/录屏)", () => {
    const p = windowVisibilityPolicy({ MHD_WINDOW: "shown" });
    expect(p.show).toBe(true);
    expect(p.focusable).toBe(true);
    expect(p.nativeAlerts).toBe(true);
  });

  it("空白值视为未设：CI 里 `MHD_WINDOW=` 不该炸", () => {
    expect(windowVisibilityPolicy({ MHD_WINDOW: "" }).show).toBe(true);
    expect(windowVisibilityPolicy({ MHD_WINDOW: "  " }).show).toBe(true);
  });

  it("非法值响亮抛错：写错一个字母若静默按 shown 走，用户窗口会被再顶一次", () => {
    expect(() => windowVisibilityPolicy({ MHD_WINDOW: "hiden" })).toThrow(/MHD_WINDOW/);
    expect(() => windowVisibilityPolicy({ MHD_WINDOW: "false" })).toThrow(/MHD_WINDOW/);
  });
});
