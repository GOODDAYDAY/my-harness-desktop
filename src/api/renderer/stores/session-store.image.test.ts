// 展示元数据(图)进中立层的运行时验证(neutral-first §4):
// 发送带图 → 乐观 __image 挂 user + display 经 prompt 传给 main 写中立层(不再写 imageIndex);
// 重开 → main 已把 display 合进 messages 的 __image,renderer 直接渲染。
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui-store";
import { useSessionStore, initSessionStore, applySnapshot } from "./session-store";

type EventHandler = (e: Record<string, unknown>) => void;

const calls = {
  append: [] as { path: string; entry: Record<string, unknown> }[],
  prompt: [] as unknown[][],
};

let eventCb: EventHandler | null = null;

function mockWindow(): void {
  calls.append = [];
  calls.prompt = [];
  eventCb = null;
  (globalThis as unknown as { window: unknown }).window = {
    kernel: {
      sessions: {
        setContext: async () => {},
        prompt: async (...args: unknown[]) => { calls.prompt.push(args); },
        sync: async () => ({}),
        setModel: async () => {},
        setThinkingLevel: async () => {},
        updateHeader: async () => ({}),
        readToolConfig: async () => null,
        openSession: async () => null,
        list: async () => [],
        getStats: async () => null,
        getThinkingLevels: async () => [],
        getCapabilities: async () => ({ kernel: "pi", locked: false, piExtension: true, dshExtension: false }),
        onEvent: (cb: EventHandler) => { eventCb = cb; return () => {}; },
        onSnapshot: () => () => {},
        onKernelEvent: () => () => {},
        onQuestion: () => () => {},
        answerQuestion: async () => {},
      },
      piSettings: { get: async () => ({}), set: async () => ({}), schema: async () => [] },
      models: { get: async () => ({}), set: async () => ({}), getFallbackModel: async () => null },
      kernel: { fitPiExtensionAvailable: async () => true, status: async () => ({ available: true }) },
      configFile: {
        readBinary: async () => "YQ==",
        append: async (p: string, e: Record<string, unknown>) => { calls.append.push({ path: p, entry: e }); },
        set: async () => {},
        get: async () => null,
        getLayered: async () => null,
        getProject: async () => null,
        setProject: async () => ({}),
        clearProject: async () => {},
      },
      config: { get: async () => undefined, set: async () => {}, all: async () => ({}), getScope: async () => ({}) },
      prefs: { get: async () => undefined, set: async () => {} },
      themes: { list: async () => [], build: async () => ({}), onSystemChanged: () => () => {} },
      fonts: { list: async () => [] },
      settings: { list: async () => [] },
      slots: {
        sidePanel: async () => [], sidebar: async () => [], mainView: async () => [], titlebar: async () => [],
        fileActions: async () => [], fileIcons: async () => [], messageActions: async () => [],
        blockRenderers: async () => [], sessionGroupings: async () => [], composerPolicies: async () => [],
        composerAttachments: async () => [], composerActions: async () => [], codeBlockRenderers: async () => [],
        settingsGroups: async () => [],
      },
      dialog: {
        openDirectory: async () => null, openImages: async () => [], openTextFile: async () => null,
        saveTextFile: async () => null, writeImages: async () => 0, saveZip: async () => null, openZip: async () => null,
      },
      openFile: async () => {},
      revealPath: async () => {},
      i18n: { resources: async () => ({ resources: {}, ns: [], supportedLngs: [] }), list: async () => [], detect: async () => "zh-CN" },
      bus: {
        status: async () => ({}), send: async () => ({ delivered: "" }), sessionCreate: async () => ({}),
        sessionAbort: async () => ({}), channelMember: async () => ({}), tapStart: async () => ({ tapId: "", filter: "" }),
        tapStop: async () => ({}), onMessage: () => () => {},
      },
      fs: {}, git: {}, gitWrite: {}, llm: {},
      plugins: {
        list: async () => [], enable: async () => ({ ok: true, error: null }), disable: async () => ({ ok: true, error: null }),
        uninstall: async () => ({ ok: true, error: null }), reload: async () => ({ ok: true, error: null }),
        reportLoadFailed: async () => {}, install: async () => ({ ok: true, error: null }),
        onUnloaded: () => () => {}, onPluginsChanged: () => () => {},
      },
      extension: {
        list: async () => [], enable: async () => {}, disable: async () => {}, reorder: async () => {},
        install: async () => ({ ok: true, error: null }), update: async () => ({ ok: true, error: null }),
        remove: async () => ({ ok: true, error: null }),
      },
      restart: {
        pendingSessions: async () => [], restart: async () => {}, restartAllIdle: async () => {},
        onStateChange: () => () => {},
      },
      skills: {
        list: async () => [], toggle: async () => {}, toggleForce: async () => {}, addPath: async () => {},
        removePath: async () => {}, getSourcePaths: async () => ({ user: [], project: [] }), getBundled: async () => ({ path: "", enabled: false }),
        setBundledEnabled: async () => {}, watch: () => () => {},
      },
      onSettingsChanged: () => () => {},
      onRefreshRequested: () => () => {},
      platform: "darwin",
      app: { info: async () => ({ name: "", version: "", electron: "", node: "", chrome: "", platform: "", isPackaged: false }), restart: async () => {} },
      window: { minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {}, isMaximized: async () => false, onMaximizedChanged: () => () => {} },
    },
  };
}

beforeEach(() => {
  mockWindow();
  useUiStore.setState({ currentCwd: "/proj", currentSessionPath: null, sessionModelPending: {}, pendingToolConfig: undefined });
  useSessionStore.setState({ messages: [], snapshot: null });
  initSessionStore();
});

describe("展示元数据(图)进中立层(neutral-first)", () => {
  it("发送带图 → 乐观 __image 挂 user + prompt 带 display(不再写 imageIndex)", async () => {
    await useSessionStore.getState().sendMessage("/proj", "ping", {
      image: { src: "~/.my-harness-desktop/s/a.gif", title: "ping" },
    });
    // 乐观 __image 挂 user 上
    expect(useSessionStore.getState().messages.some((m) => m.role === "user" && (m as { __image?: unknown }).__image)).toBe(true);
    // display 经 prompt 第三参传给 main(写中立层),不进底座会话文件、不进 imageIndex
    expect(calls.prompt).toHaveLength(1);
    expect(calls.prompt[0][0]).toBe("ping");
    expect(calls.prompt[0][1]).toBeUndefined(); // 无 vision images
    expect(calls.prompt[0][2]).toEqual({ image: { src: "~/.my-harness-desktop/s/a.gif", title: "ping" } });
    // 不再 append custom_message 到底座文件
    expect(calls.append.some((a) => a.entry.type === "custom_message")).toBe(false);
  });

  it("发送不带图 → prompt 不带 display", async () => {
    await useSessionStore.getState().sendMessage("/proj", "ping");
    expect(calls.prompt).toHaveLength(1);
    expect(calls.prompt[0][2]).toBeUndefined();
  });

  it("openSession:message 已带 __image(main 从中立层合入)→ 直接可渲染", async () => {
    const detail = {
      info: { cwd: "/proj", id: "s1" },
      messages: [
        { id: "u1", role: "user", content: "ping", __image: { src: "~/.my-harness-desktop/s/b.png" } },
        { id: "a1", role: "assistant", content: "ok" },
      ],
      stats: null,
    };
    (window as unknown as { kernel: { sessions: { openSession: () => Promise<unknown> } } }).kernel.sessions.openSession = async () => detail;
    useUiStore.setState({ currentCwd: "/proj", currentSessionPath: "/s/b.jsonl", sessionModelPending: {} });
    await useSessionStore.getState().openSession("/s/b.jsonl");
    const user = useSessionStore.getState().messages.find((m) => m.role === "user");
    expect((user as { __image?: { src: string } }).__image).toEqual({ src: "~/.my-harness-desktop/s/b.png" });
  });

  it("applySnapshot:空快照不冲掉乐观消息(首图锚定不被 warmup 的 start sync 清掉)", () => {
    const s = useSessionStore.getState();
    const optimistic = { id: "tmp1", role: "user", content: "你好", __optimistic: true, __image: { src: "x" } } as never;
    const snapshot = { state: {}, entries: [], messages: [] } as never;
    const partial = applySnapshot({ ...s, messages: [optimistic], syncNonce: 3 }, snapshot);
    expect(partial.messages).toBeUndefined(); // 未替换 messages
    expect(partial.syncNonce).toBeUndefined(); // 未递增
    expect(partial.snapshot).toBe(snapshot); // 基线照常更新
  });

  it("applySnapshot:非空快照照常全量替换并递增 syncNonce", () => {
    const s = useSessionStore.getState();
    const msgs = [{ id: "m1", role: "assistant", content: "回复" }];
    const snapshot = { state: {}, entries: [], messages: msgs } as never;
    const partial = applySnapshot({ ...s, messages: [], syncNonce: 3 }, snapshot);
    expect(partial.messages).toEqual(msgs);
    expect(partial.syncNonce).toBe(4);
  });
});
