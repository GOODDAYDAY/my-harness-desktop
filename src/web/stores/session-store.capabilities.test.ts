// 能力面 push 守卫(根因修复:能力面是「拉式缓存 + N 个命令式刷新点」,每加一个生命周期
// 转变就多一个失同步窗口。收口:main 在能力变化点广播 capabilitiesChanged/kernelChanged
// (带完整快照),renderer 订阅即到位——不再散拉 refreshCapabilities。)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useSessionStore, initSessionStore } from "./session-store";
import { useUiStore } from "./ui-store";
import type { KernelEvent } from "@my-harness-desktop/shared";

type KernelCb = (e: KernelEvent) => void;

/** 最小 window.kernel mock:只装 initSessionStore 触达的面。 */
function stubKernel(capture: { kernelCb?: KernelCb }, capabilities: () => Promise<unknown>) {
  const sessions = {
    setContext: async () => {},
    list: async () => [],
    getCapabilities: capabilities,
    getStats: async () => null,
    sync: async () => { throw new Error("no-kernel"); },
    onEvent: () => () => {},
    onSnapshot: () => () => {},
    onKernelEvent: (cb: KernelCb) => { capture.kernelCb = cb; return () => {}; },
    onHeaderChanged: () => () => {},
    onNeutralChange: () => () => {},
    getNeutral: async () => ({ session: null, activeLineageId: null }),
  };
  vi.stubGlobal("window", { kernel: { sessions } });
}

describe("能力面 push(capabilitiesChanged 事件)", () => {
  beforeEach(() => {
    useUiStore.setState({ currentCwd: "/proj", currentSessionPath: null });
    useSessionStore.setState({
      capabilities: { kernel: null, locked: false, extension: false, thinking: false },
    });
  });

  it("capabilitiesChanged 事件 → 直接采信推来的能力面快照,不重拉 getCapabilities", async () => {
    const capture: { kernelCb?: KernelCb } = {};
    let pulls = 0;
    stubKernel(capture, async () => {
      pulls += 1;
      return { kernel: "pi", locked: false, extension: false, thinking: false };
    });
    initSessionStore();
    await new Promise((r) => setTimeout(r, 0));
    expect(useSessionStore.getState().capabilities.extension).toBe(false);

    // main 在 proc 就绪后推 capabilitiesChanged(带完整快照,extension 已转真)
    capture.kernelCb?.({
      kind: "capabilitiesChanged",
      sessionKey: "k",
      capabilities: { kernel: "pi", locked: false, extension: true, thinking: false },
    });
    await new Promise((r) => setTimeout(r, 0));

    // 能力面直接从事件 payload 落,不再触发 getCapabilities 重拉(拉式刷新点已删)
    expect(pulls).toBe(1); // 只有 init 拉一次
    expect(useSessionStore.getState().capabilities.extension).toBe(true);
  });

  it("静态守卫:refreshCapabilities 只允许冷启动一次(防退化回拉式刷新点)", () => {
    const src = readFileSync(fileURLToPath(new URL("./session-store.ts", import.meta.url)), "utf-8");
    const calls = (src.match(/refreshCapabilities\(\);/g) ?? []).length;
    expect(calls).toBe(1); // 只有 init 冷启动基线;能力变化走 push 事件,不再加命令式刷新点
  });
});
