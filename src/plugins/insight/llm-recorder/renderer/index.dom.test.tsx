// @vitest-environment jsdom
// 请求记录面板的**增量刷新触发**守卫 —— 用户报告 #20 的第二个根因。
//
// 症状：「dsh 内核执行的时候右侧的请求记录就没有记录了」。
// 记录其实**已经落盘**了（写侧另有守卫），空的是**面板没重读**。根因是触发时机：
//   · pi 侧扩展在 `messageEnd` 那一刻就写完该 seq 的配对行 → 订阅 messageEnd 够用；
//   · dsh 侧的 response 行**不在**那一刻写，它等回合边界 `agent/turn-stopping`（映射成中性
//     事件 `agentSettled`）才结算，而回合边界在 shell 的 messageEnd **之后**。
//   于是只订阅 messageEnd 时，面板读到的永远是「请求已发、响应未回」，结算行落盘后再无事件
//   触发重读 —— 除非用户切会话/重挂面板，否则那条记录的状态**永不流转**。
//
// 为什么这条守卫非有不可：这段逻辑此前**只有一段注释**在说它重要（注释还写了
// 「只订阅 messageEnd 的话面板读到的永远是未返回」），一行测试都没有。注释拦不住回退。
//
// 断言方式：把 `ctx.fs.readFile` 做成"内容会变"的假盘 —— 先只有 request 行（未返回），
// 补上 response 行后**只在事件到达时**才应该被读到。于是"面板有没有重读"直接可观测：
// 重读了 → 状态从「未返回」变成状态码；没重读 → 一直停在「未返回」。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  /** 假盘：分片名 → 内容。测试中途改它来模拟"写侧新落了一行"。 */
  files: new Map<string, string>(),
  /** onEvent 注册的处理器（模拟主侧推事件）。 */
  handlers: [] as ((e: { type: string }) => void)[],
  readCount: 0,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock("@my-harness-desktop/react", async () => {
  const React = await import("react");
  // ⚠ ctx 必须**稳定**（真实 PluginContext 跨渲染是同一个对象）。
  //   第一版每次调用都新建一个对象 → `ctx.fs` 每次渲染都是新引用 → 组件里
  //   `useCallback([ctx.fs, …])` / `useEffect([fullLoad])` 每渲染重跑 → setState → 无限回环，
  //   vitest worker 直接崩（现场表现为 "Worker exited unexpectedly"，看不出是回环）。
  //   测试替身与真实对象在**身份稳定性**上必须一致，否则测的是另一套语义。
  const ctx = {
    pluginId: "llm-recorder",
    fs: {
      // 条目形态是 `{name, isDir}`；分片名要么**恰好等于**会话文件名（= 分片 1），
      // 要么是 `<base>.<N>.jsonl`（shardNumber 的判据）。第一版我写成 `kind:"file"` +
      // 错的分片名，面板读出来是空列表 —— 现场显示「panel.empty」，看着像组件坏了。
      listDir: async () => [...h.files.keys()].map((name) => ({ name, isDir: false })),
      readFile: async (p: string) => {
        h.readCount += 1;
        const name = p.split("/").pop() ?? "";
        if (!h.files.has(name)) throw new Error(`no such file: ${name}`);
        return h.files.get(name)!;
      },
    },
    sessions: {
      onEvent: (cb: (e: { type: string }) => void) => {
        h.handlers.push(cb);
        return () => { h.handlers = h.handlers.filter((x) => x !== cb); };
      },
    },
  };
  return {
    usePluginContext: () => ctx,
    // 只实现面板真正用到的两个 store 选择器（按选择器调用，与真实 hook 同形）
    useUiStore: <T,>(sel: (s: { currentCwd: string; currentSessionPath: string; currentNeutralSessionId: string }) => T): T =>
      sel({ currentCwd: "/proj", currentSessionPath: "/kernels/pi/sessions/ns-1.jsonl", currentNeutralSessionId: "ns-1" }),
    EmptyState: ({ title }: { title: string }) => React.createElement("div", null, title),
    Button: ({ children }: { children?: React.ReactNode }) => React.createElement("button", null, children),
    SettingsSection: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
  };
});

import { RecordsTab } from "./index";

const REQUEST_LINE = JSON.stringify({ seq: 1, ts: 1_700_000_000_000, kind: "request", turnIndex: 1, payload: { model: "m" } });
const RESPONSE_LINE = JSON.stringify({ seq: 1, ts: 1_700_000_001_000, kind: "response", status: 200, durationMs: 1000, message: {} });
const SHARD = "ns-1.jsonl"; // == sessionPath 的 basename（分片 1）

beforeEach(() => {
  h.files = new Map([[SHARD, REQUEST_LINE + "\n"]]);
  h.handlers = [];
  h.readCount = 0;
});

/** 主侧推一个中性事件（包在 act 里让 React 处理连带的状态更新）。 */
async function emit(type: string): Promise<void> {
  await act(async () => {
    for (const cb of [...h.handlers]) cb({ type });
  });
}

describe("请求记录面板:增量刷新的触发时机（#20 第二根因）", () => {
  it("刚打开时读到 request 无 response → 显示「未返回」", async () => {
    render(<RecordsTab isActive={true} />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(screen.getByText("panel.notReturned"), "还没有 response 行时应显示未返回").toBeInTheDocument();
  });

  it("★ **agentSettled（回合边界）到达时必须重读** —— dsh 的结算行就在这一刻落盘", async () => {
    render(<RecordsTab isActive={true} />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());

    // 写侧在回合边界落下了配对行（dsh 的真实时序）
    h.files.set(SHARD, REQUEST_LINE + "\n" + RESPONSE_LINE + "\n");
    await emit("agentSettled");

    // 只订阅 messageEnd 的实现会在这里停住：面板永远显示「未返回」
    await waitFor(() =>
      expect(screen.queryByText("panel.notReturned"), "回合边界到了却不重读 —— dsh 的记录会永远停在「未返回」").toBeNull(),
    );
    expect(screen.getByText("200"), "重读后应显示真实状态码").toBeInTheDocument();
  });

  it("messageEnd 也触发重读 —— pi 侧在这一刻就写完配对行（不能只留 agentSettled）", async () => {
    render(<RecordsTab isActive={true} />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    h.files.set(SHARD, REQUEST_LINE + "\n" + RESPONSE_LINE + "\n");
    await emit("messageEnd");
    await waitFor(() => expect(screen.queryByText("panel.notReturned")).toBeNull());
  });

  it("无关事件不触发读盘（不是每次都全量重读）", async () => {
    render(<RecordsTab isActive={true} />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    const before = h.readCount;
    await emit("toolCallEnd");
    await emit("entryAppended");
    expect(h.readCount, "无关事件也去读盘 = 白读（增量触发的意义就没了）").toBe(before);
  });

  it("面板不活跃时事件到了也不读（订阅保留、跳过读盘）", async () => {
    render(<RecordsTab isActive={false} />);
    await waitFor(() => expect(h.handlers.length).toBeGreaterThan(0));
    const before = h.readCount;
    h.files.set(SHARD, REQUEST_LINE + "\n" + RESPONSE_LINE + "\n");
    await emit("agentSettled");
    expect(h.readCount, "面板没显示却去读盘").toBe(before);
  });
});
