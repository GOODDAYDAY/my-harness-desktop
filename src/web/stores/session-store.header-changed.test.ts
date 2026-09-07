// headerChanged 增量广播路由(neutral-storage-split §2.6)与本地补丁动作的守卫:
// updateHeader/rename/delete 本地打行不重拉;copy/fork 等整行增减才重拉。
// 此前任何归档/置顶/改名都触发全端全目录重扫(N=1089 实测 1.75s/次/端)。
//
// 注意:initSessionStore 有 inited 幂等守卫,订阅只在首次挂——本文件一律用
// beforeAll 单次 init + 共享 capture,逐用例重 init 会拿到 undefined 回调(踩过的坑)。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { useSessionStore, initSessionStore } from "./session-store";
import { useUiStore } from "./ui-store";
import type { SessionHeaderChangedEvent, SessionInfo } from "@my-harness-desktop/shared";

type HeaderCb = (e: SessionHeaderChangedEvent) => void;

const shared: { headerCb?: HeaderCb; listCalls: string[] } = { listCalls: [] };

/** 最小 window.kernel mock:捕获 headerChanged 订阅,list 计数(断言不重拉/重拉)。 */
function stubKernel() {
  const sessions = {
    setContext: async () => {},
    list: async (cwd: string) => { shared.listCalls.push(cwd); return []; },
    getCapabilities: async () => ({ kernel: null, locked: false, piExtension: false, dshExtension: false }),
    getStats: async () => null,
    sync: async () => { throw new Error("no-kernel"); },
    onEvent: () => () => {},
    onSnapshot: () => () => {},
    onKernelEvent: () => () => {},
    onHeaderChanged: (cb: HeaderCb) => { shared.headerCb = cb; return () => {}; },
    onNeutralChange: () => () => {},
    getNeutral: async () => ({ session: null, activeLineageId: null }),
  };
  vi.stubGlobal("window", { kernel: { sessions } });
}

const row = (path: string, ns: string): SessionInfo => ({
  path,
  id: ns,
  neutralSessionId: ns,
  cwd: "/proj",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
});

describe("headerChanged 增量路由 + 本地补丁动作", () => {
  beforeAll(() => {
    // cwd 置 null 再 init:初始 loadForCwd 空转,订阅挂上且零 list 调用。
    useUiStore.setState({ currentCwd: undefined, currentSessionPath: null });
    stubKernel();
    initSessionStore();
  });

  beforeEach(() => {
    useUiStore.setState({ currentCwd: undefined, currentSessionPath: null });
    useSessionStore.setState({
      sessionInfos: {
        "/p/a.jsonl": row("/p/a.jsonl", "ns-a"),
        "ns-a": row("/p/a.jsonl", "ns-a"),
        "/p/b.jsonl": row("/p/b.jsonl", "ns-b"),
        "ns-b": row("/p/b.jsonl", "ns-b"),
      },
      sessionInfosCwd: "/proj",
    });
    shared.listCalls.length = 0;
  });

  it("updateHeader 广播:本地打补丁(path 与 ns 双键同改),不触发列表重拉", () => {
    shared.headerCb?.({ kind: "updateHeader", sessionPath: "/p/a.jsonl", patch: { archived: true } });
    const infos = useSessionStore.getState().sessionInfos!;
    expect(infos["/p/a.jsonl"].archived).toBe(true);
    expect(infos["ns-a"].archived).toBe(true); // ns 别名键同步
    expect(infos["/p/b.jsonl"].archived).toBeUndefined(); // 邻居不动
    expect(shared.listCalls).toEqual([]); // 不重拉
  });

  it("rename 广播:name 本地生效,不重拉", () => {
    shared.headerCb?.({ kind: "rename", sessionPath: "/p/a.jsonl", name: "新名字" });
    expect(useSessionStore.getState().sessionInfos!["ns-a"].name).toBe("新名字");
    expect(shared.listCalls).toEqual([]);
  });

  it("delete 广播:行连 ns 别名键一起摘,不重拉", () => {
    shared.headerCb?.({ kind: "delete", paths: ["/p/a.jsonl"] });
    const infos = useSessionStore.getState().sessionInfos!;
    expect(infos["/p/a.jsonl"]).toBeUndefined();
    expect(infos["ns-a"]).toBeUndefined();
    expect(infos["/p/b.jsonl"]).toBeTruthy();
    expect(shared.listCalls).toEqual([]);
  });

  it("copy/clone 等整行增减:本地无行可补丁,重拉一次", async () => {
    // 先落 cwd(cwd 订阅会触发一次基线拉取),落定后清零计数再发广播。
    useUiStore.setState({ currentCwd: "/proj" });
    await new Promise((r) => setTimeout(r, 0));
    shared.listCalls.length = 0;
    shared.headerCb?.({ kind: "copy", sessionPath: "/p/copy.jsonl" });
    shared.headerCb?.({ kind: "clone" });
    await new Promise((r) => setTimeout(r, 0));
    expect(shared.listCalls).toEqual(["/proj", "/proj"]);
  });

  it("applyHeaderPatch 数组形态(批量归档):一次调用改多行", () => {
    useSessionStore.getState().applyHeaderPatch(["/p/a.jsonl", "/p/b.jsonl"], { archived: true });
    const infos = useSessionStore.getState().sessionInfos!;
    expect(infos["ns-a"].archived).toBe(true);
    expect(infos["ns-b"].archived).toBe(true);
  });

  it("applyHeaderPatch 对未知 path 安静跳过(广播先于初始拉取到达不炸)", () => {
    useSessionStore.getState().applyHeaderPatch("/p/ghost.jsonl", { pinned: true });
    expect(useSessionStore.getState().sessionInfos!["/p/a.jsonl"].pinned).toBeUndefined();
  });
});
