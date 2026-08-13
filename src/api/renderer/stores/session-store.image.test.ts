// 会话流图片"刷新后消失"的诊断:落盘链路验证。
// sendMessage 带图 → pending 入队 → onEvent(messageEnd assistant) → flush → configFile.append。
// mock window.pi(不含 Electron),模拟新会话首条带图发送的完整时序。
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui-store";
import { useSessionStore, initSessionStore } from "./session-store";

type EventHandler = (e: Record<string, unknown>) => void;

const calls = {
  append: [] as { path: string; entry: Record<string, unknown> }[],
  readBinary: [] as string[],
  setContext: [] as string[],
  prompt: [] as string[],
};

let eventCb: EventHandler | null = null;

function mockWindow(): void {
  calls.append = [];
  calls.readBinary = [];
  calls.setContext = [];
  calls.prompt = [];
  eventCb = null;
  (globalThis as unknown as { window: unknown }).window = {
    pi: {
      sessions: {
        setContext: async (_cwd: string, _sp: string | null) => { calls.setContext.push(String(_sp)); },
        prompt: async (text: string) => { calls.prompt.push(text); },
        sync: async () => ({}),
        setModel: async () => {},
        setThinkingLevel: async () => {},
        updateHeader: async () => ({}),
        readToolConfig: async () => null,
        list: async () => [],
        getStats: async () => null,
        getThinkingLevels: async () => [],
        onEvent: (cb: EventHandler) => { eventCb = cb; return () => {}; },
        onSnapshot: () => () => {},
        onKernelEvent: () => () => {},
        onExtensionUI: () => () => {},
        replyExtensionUI: async () => {},
      },
      piSettings: { get: async () => ({}), set: async () => ({}), schema: async () => [] },
      models: { get: async () => ({}), set: async () => ({}) },
      kernel: { toolgateAvailable: async () => true, status: async () => ({ available: true }) },
      configFile: {
        readBinary: async (p: string) => { calls.readBinary.push(p); return "YQ=="; }, // 底座已写盘(非空)
        append: async (p: string, e: Record<string, unknown>) => { calls.append.push({ path: p, entry: e }); },
        set: async () => {},
        get: async () => ({}),
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
  useSessionStore.setState({ messages: [], snapshot: null, streaming: false });
  initSessionStore();
});

describe("会话流图片落盘链路(新会话首条带图)", () => {
  it("sendMessage 带图 → pending → messageEnd(assistant) flush → configFile.append custom_message", async () => {
    await useSessionStore.getState().sendMessage("/proj", "帮我整理日报", {
      image: { src: "~/.pi-desktop/stickers/banners/x.png", title: "日报" },
    });
    // 发送成功:prompt 被调,乐观 user 带 __image
    expect(calls.prompt.length).toBe(1);
    expect(useSessionStore.getState().messages.some((m) => m.role === "user" && (m as { __image?: unknown }).__image)).toBe(true);
    // 新会话:currentSessionPath 尚未水合 → pending 已入队(此时未 append)
    expect(calls.append.some((a) => a.entry.type === "custom_message")).toBe(false);
    // 模拟底座写盘时序:sessionStart 水合路径 → assistant messageEnd → flush
    const sessionFile = "/Users/x/.pi/agent/sessions/b/2026-01-01T00-00-00_a.jsonl";
    eventCb?.({ type: "sessionStart", sessionFile });
    eventCb?.({ type: "messageEnd", message: { role: "assistant" } });
    // flush 是 fire-and-forget async(内部 await readBinary),等一个 tick 完成
    await new Promise((r) => setTimeout(r, 20));
    // flush:sessionKey 匹配 + 探测非空 → append custom_message 图条目
    const appended = calls.append.find((a) => a.entry.type === "custom_message");
    expect(appended).toBeTruthy();
    expect(appended!.path).toBe(sessionFile);
    expect((appended!.entry as { customType: string }).customType).toBe("image");
  });

  it("旧会话(已有 assistant 历史)prompt 后探测非空立即 append", async () => {
    useSessionStore.setState({ messages: [{ id: "old-a", role: "assistant", content: "x" } as never] });
    useUiStore.setState({ currentSessionPath: "/Users/x/.pi/agent/sessions/b/old.jsonl" });
    await useSessionStore.getState().sendMessage("/proj", "带图", {
      image: { src: "~/.pi-desktop/s/a.png" },
    });
    // 旧会话:prompt 后 readBinary 探测非空 → 立即 append
    expect(calls.readBinary.length).toBeGreaterThan(0);
    expect(calls.append.some((a) => a.entry.type === "custom_message")).toBe(true);
  });
});
