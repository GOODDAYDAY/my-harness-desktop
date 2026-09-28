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

const shared: { headerCb?: HeaderCb; refreshCb?: () => void; listCalls: string[] } = { listCalls: [] };

/** 最小 window.kernel mock:捕获 headerChanged 订阅,list 计数(断言不重拉/重拉)。 */
function stubKernel() {
  const sessions = {
    setContext: async () => {},
    list: async (cwd: string) => { shared.listCalls.push(cwd); return []; },
    getCapabilities: async () => ({ kernel: null, locked: false, faces: {}, thinkingCycle: false, levelsSemantics: "precise" }),
    getStats: async () => null,
    sync: async () => { throw new Error("no-kernel"); },
    onEvent: () => () => {},
    onSnapshot: () => () => {},
    onKernelEvent: () => () => {},
    onHeaderChanged: (cb: HeaderCb) => { shared.headerCb = cb; return () => {}; },
    onNeutralChange: () => () => {},
    getNeutral: async () => ({ session: null, activeLineageId: null }),
  };
  // onRefreshRequested 是 window.kernel 的**顶层**面（不是 sessions 下的）。
  // 替身必须带上它：initSessionStore 会订阅（r19 起，内核集合变了要重拉 sessionInfos，
  // 否则会话行的 kernelLoaded 旗标 stale → 角标与只读条都不出现）。
  // 这里顺便**捕获回调**，好在下面断言"信号到达 → 真的重拉了列表"。
  const onRefreshRequested = (cb: () => void) => { shared.refreshCb = cb; return () => {}; };
  vi.stubGlobal("window", { kernel: { sessions, onRefreshRequested } });
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

  // ---- r19 的修复：内核集合变了要重拉列表（否则 kernelLoaded 旗标 stale）----
  //
  // 每一行的 `kernelLoaded` 是 main 侧按**当时的注册表**算好下发的。内核插件重载把某个内核
  // unregister 之后，main 侧立刻算对了，但 renderer 手里的 `sessionInfos` 还是旧旗标——
  // 于是会话行不显示"内核未装载"角标、时间线不显示只读条，用户点发送要到服务端才被处置。
  // 修法是让框架的拉取口也订阅中性 `refresh.requested`。这条断言就是那个订阅的守卫。
  it("收到 refresh.requested → 重拉当前 cwd 的会话列表", async () => {
    useUiStore.setState({ currentCwd: "/proj" });
    shared.listCalls.length = 0;
    expect(shared.refreshCb, "initSessionStore 应已订阅刷新信号（替身捕获不到 = 订阅没装）").toBeTypeOf("function");
    shared.refreshCb!();
    await new Promise((r) => setTimeout(r, 0));
    expect(shared.listCalls, "刷新信号到达必须重拉列表（否则 kernelLoaded 旗标停在上一批）").toContain("/proj");
  });

  it("没有当前 cwd 时不拉（拉了也是白拉，且会把 sessionInfosCwd 弄脏）", async () => {
    useUiStore.setState({ currentCwd: undefined });
    shared.listCalls.length = 0;
    shared.refreshCb!();
    await new Promise((r) => setTimeout(r, 0));
    expect(shared.listCalls).toEqual([]);
  });
});
