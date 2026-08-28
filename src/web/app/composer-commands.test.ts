// composer-commands 注册表 + 发送前拦截胶水单测(机制面,镜像 event-bus.test.ts 的位置纪律)。
// 消费方是 timeline 的 sendText:命中且 handle 返回 true → 吞掉发送;其余一律放行。
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerComposerCommands, unregisterComposerCommands, getComposerCommands, runComposerCommandIfMatch } from "@my-harness-desktop/react";

afterEach(() => {
  unregisterComposerCommands(["goal", "note", "boom"]);
});

describe("composerCommands 注册表", () => {
  it("注册/读取/按名注销", () => {
    registerComposerCommands([
      { name: "goal", handle: () => true },
      { name: "note", handle: () => false },
    ]);
    expect(getComposerCommands().map((c) => c.name)).toEqual(expect.arrayContaining(["goal", "note"]));

    unregisterComposerCommands(["goal"]);
    expect(getComposerCommands().some((c) => c.name === "goal")).toBe(false);
    expect(getComposerCommands().some((c) => c.name === "note")).toBe(true);
  });

  it("同名重复注册 = 替换(后注册者胜)", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    registerComposerCommands([{ name: "goal", handle: first }]);
    registerComposerCommands([{ name: "goal", handle: second }]);
    expect(getComposerCommands().filter((c) => c.name === "goal")).toHaveLength(1);
  });
});

describe("runComposerCommandIfMatch(发送前拦截)", () => {
  it("命中且 handle 返回 true → true(吞掉发送)", async () => {
    const handle = vi.fn(() => true);
    registerComposerCommands([{ name: "goal", handle }]);
    await expect(runComposerCommandIfMatch("/goal 写 README")).resolves.toBe(true);
    expect(handle).toHaveBeenCalledWith("/goal 写 README");
  });

  it("命中但 handle 返回 false → false(放行)", async () => {
    registerComposerCommands([{ name: "goal", handle: () => false }]);
    await expect(runComposerCommandIfMatch("/goal x")).resolves.toBe(false);
  });

  it("支持异步 handle", async () => {
    registerComposerCommands([{ name: "goal", handle: async () => true }]);
    await expect(runComposerCommandIfMatch("/goal x")).resolves.toBe(true);
  });

  it("未命中 → false,handle 不被调", async () => {
    const handle = vi.fn(() => true);
    registerComposerCommands([{ name: "goal", handle }]);
    await expect(runComposerCommandIfMatch("普通消息")).resolves.toBe(false);
    await expect(runComposerCommandIfMatch("/goalx")).resolves.toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it("handle 抛错 → 按未处理放行(命令故障不阻塞用户发送)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerComposerCommands([{ name: "boom", handle: () => { throw new Error("x"); } }]);
    await expect(runComposerCommandIfMatch("/boom")).resolves.toBe(false);
    warn.mockRestore();
  });
});
