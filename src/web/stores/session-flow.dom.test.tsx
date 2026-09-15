// @vitest-environment jsdom
// 会话流 DOM 交互测试(session-single-source 渲染读口的端到端钉,jsdom 级):
// 真实 React 渲染 + 真实 store + 模拟内核面——驱动「基线到达 → 发送乐观回显 →
// 写穿回执 → 定稿转正」全序列,断言 DOM 文本与消息结构。
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import React from "react";
import { useSessionStore, initSessionStore } from "./session-store";
import { useUiStore } from "./ui-store";
import type { NeutralChange, NeutralSession, NeutralEntry } from "@my-harness-desktop/shared";
import { emptyNeutralSession } from "@my-harness-desktop/shared";

type EventHandler = (e: Record<string, unknown>) => void;

let eventCb: EventHandler | null = null;
let neutralCb: ((c: NeutralChange) => void) | null = null;
let baseline: { session: NeutralSession | null; activeLineageId: string | null } = { session: null, activeLineageId: null };

function mockWindow(): void {
  eventCb = null;
  neutralCb = null;
  // jsdom 环境下只换 window.kernel 面(不替换 window 本身——react-dom 的
  // getSelectionInformation 依赖真实 DOM 全局,整换会炸 commit 阶段)。
  (window as unknown as { kernel: unknown }).kernel = {
    sessions: {
      setContext: async () => {},
      prompt: async () => {},
      sync: async () => ({}),
      list: async () => [],
      getStats: async () => null,
      getCapabilities: async () => ({ kernel: "pi", locked: false, extension: true, thinking: false }),
      getNeutral: async () => baseline,
      onEvent: (cb: EventHandler) => { eventCb = cb; return () => {}; },
      onNeutralChange: (cb: (c: NeutralChange) => void) => { neutralCb = cb; return () => {}; },
      onSnapshot: () => () => {},
      onKernelEvent: () => () => {},
      onHeaderChanged: () => () => {},
    },
    models: { getFallbackModel: async () => null },
    kernel: { fitPiExtensionAvailable: async () => true },
  };
}

/** 探针组件:把 store.messages 渲成 DOM(每条消息一个 [data-role] 行)。 */
function Probe() {
  const messages = useSessionStore((s) => s.messages);
  return (
    <div data-testid="timeline">
      {messages.map((m, i) => (
        <div key={m.id ?? i} data-role={m.role} data-pending={m.pending === true ? "1" : "0"}>
          {typeof m.content === "string" ? m.content : JSON.stringify(m.content)}
        </div>
      ))}
    </div>
  );
}

function entry(lid: string, seq: number, role: string, text: string): NeutralEntry {
  return { neutralEntryId: `${lid}:${seq}`, message: { role, content: text } };
}

function change(ns: string, e: NeutralEntry): NeutralChange {
  return { ns, kind: "entry", lineageId: "root", entry: e, header: { kernel: "pi", cwd: "/p", createdAt: "t" } };
}

describe("会话流 DOM 交互(镜像读口全序列)", () => {
  beforeEach(() => {
    cleanup();
    mockWindow();
    baseline = { session: null, activeLineageId: null };
    useUiStore.setState({ currentCwd: "/proj", currentSessionPath: null, currentNeutralSessionId: null });
    useSessionStore.setState({ messages: [], overlay: [], snapshot: null, streaming: false });
  });

  it("基线 → 发送乐观回显 → 写穿回执转正 → 定稿落位,DOM 全程一致", async () => {
    // 基线:已有一条历史问答的中立会话
    baseline = {
      session: {
        ...emptyNeutralSession("ns-1", { kernel: "pi", cwd: "/proj", createdAt: "t" }),
        lineages: [{ lineageId: "root", fork: null, entries: [entry("root", 0, "user", "历史问"), entry("root", 1, "assistant", "历史答")] }],
      },
      activeLineageId: "root",
    };
    initSessionStore();

    render(<Probe />);
    // 切到该会话 → 镜像读基线 → DOM 渲出历史
    await act(async () => {
      useUiStore.getState().setCurrentSessionPath("/p/ns-1.jsonl");
      useUiStore.getState().setCurrentNeutralSessionId("ns-1");
      await Promise.resolve();
    });
    expect(screen.getByText("历史问")).toBeTruthy();
    expect(screen.getByText("历史答")).toBeTruthy();

    // 发送:乐观气泡(user) + pending 占位(assistant)进 DOM
    await act(async () => {
      await useSessionStore.getState().sendMessage("/proj", "新问题");
    });
    expect(screen.getByText("新问题")).toBeTruthy();
    expect(document.querySelector("[data-role='assistant'][data-pending='1']")).toBeTruthy();

    // 流式事件:内容进占位(执行态视觉)
    act(() => {
      eventCb?.({ type: "messageStart", message: { role: "assistant", content: "" } });
      eventCb?.({ type: "messageUpdate", message: { role: "assistant", content: "流式中…" } });
    });
    expect(screen.getByText("流式中…")).toBeTruthy();

    // 写穿回执:assistant 定稿条目进镜像(主侧先写穿再广播,回执先于 messageEnd)
    act(() => {
      neutralCb?.(change("ns-1", entry("root", 2, "user", "新问题")));
      neutralCb?.(change("ns-1", entry("root", 3, "assistant", "新答")));
    });
    // messageEnd:占位摘除
    act(() => {
      eventCb?.({ type: "messageEnd", message: { role: "assistant", content: "新答" } });
    });
    expect(screen.getByText("新答")).toBeTruthy();
    // 乐观气泡已转正(镜像同文覆盖),不双条
    expect(screen.getAllByText("新问题")).toHaveLength(1);
    // pending 占位已清
    expect(document.querySelector("[data-pending='1']")).toBeNull();
    // 全序列:历史2 + 新问答2,共 4 行
    expect(document.querySelectorAll("[data-role]")).toHaveLength(4);
  });

  it("新会话(无中立层):叠加层照常显示乐观回显与流式占位", async () => {
    initSessionStore();
    render(<Probe />);
    await act(async () => {
      await useSessionStore.getState().sendMessage("/proj", "首条");
    });
    expect(screen.getByText("首条")).toBeTruthy();
    expect(document.querySelector("[data-role='assistant'][data-pending='1']")).toBeTruthy();
  });
});
