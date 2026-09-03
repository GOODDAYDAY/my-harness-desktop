// 能力面刷新守卫(根因修复:新会话壳首发前 piExtension=false,首发 sessionStart 时进程已注册
// 转真——此前没人刷新,思考档位 levels 恒空、开关 disabled 到切会话才自愈)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSessionStore, initSessionStore } from "./session-store";
import { useUiStore } from "./ui-store";
import type { SessionEvent } from "@my-harness-desktop/shared";

type EventCb = (e: SessionEvent) => void;

/** 最小 window.kernel mock:只装 initSessionStore 触达的面。 */
function stubKernel(capture: { eventCb?: EventCb }, capabilities: () => Promise<unknown>) {
  const sessions = {
    setContext: async () => {},
    list: async () => [],
    getCapabilities: capabilities,
    getStats: async () => null,
    sync: async () => { throw new Error("no-kernel"); },
    onEvent: (cb: EventCb) => { capture.eventCb = cb; return () => {}; },
    onSnapshot: () => () => {},
    onKernelEvent: () => () => {},
    onHeaderChanged: () => () => {},
    onNeutralChange: () => () => {},
    getNeutral: async () => ({ session: null, activeLineageId: null }),
  };
  vi.stubGlobal("window", { kernel: { sessions } });
}

describe("能力面刷新(sessionStart 触发)", () => {
  beforeEach(() => {
    useUiStore.setState({ currentCwd: "/proj", currentSessionPath: null });
    useSessionStore.setState({
      capabilities: { kernel: null, locked: false, piExtension: false, dshExtension: false },
    });
  });

  it("首发 sessionStart → 重拉 getCapabilities,piExtension 转真", async () => {
    const capture: { eventCb?: EventCb } = {};
    let calls = 0;
    stubKernel(capture, async () => {
      calls += 1;
      // 首发前:无进程(假);首发后:pi 进程在(piExtension=true)
      return { kernel: "pi", locked: false, piExtension: calls >= 2, dshExtension: false };
    });
    initSessionStore();
    // init 拉一次(piExtension=false)
    await new Promise((r) => setTimeout(r, 0));
    expect(useSessionStore.getState().capabilities.piExtension).toBe(false);
    // 首发 sessionStart 到达 → 应重拉
    capture.eventCb?.({ type: "sessionStart", sessionFile: "/tmp/s.jsonl", neutralSessionId: "ns-1" } as unknown as SessionEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(useSessionStore.getState().capabilities.piExtension).toBe(true);
  });
});
