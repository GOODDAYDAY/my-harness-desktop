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
        openSession: async () => null,
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

  it("entryAppended(user) 水合:乐观 user(__image) 应被锚定(用户日志的'水合失败'诊断)", async () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    try {
      await useSessionStore.getState().sendMessage("/proj", "帮我整理日报", {
        image: { src: "~/.pi-desktop/stickers/banners/x.png" },
      });
      // 乐观:user(__image) + assistant(pending)
      const before = useSessionStore.getState().messages;
      expect(before.some((m) => m.role === "user" && (m as { __image?: unknown }).__image)).toBe(true);
      // 模拟底座写 user 消息条目 → entryAppended 水合
      eventCb?.({
        type: "entryAppended",
        entry: { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "帮我整理日报" } },
      });
      await new Promise((r) => setTimeout(r, 20));
      const after = useSessionStore.getState().messages;
      // user 应被水合(id 建立)或至少保留(带 __image)
      const user = after.find((m) => m.role === "user" && (m as { __image?: unknown }).__image);
      expect(user).toBeTruthy();
      // 不应出现"水合失败"警告
      expect(warns.some((w) => w.includes("水合失败"))).toBe(false);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("桌面图片索引(imageIndex,独立于底座快照)", () => {
  it("发送带图 → 乐观记录 imageIndex(user 内容 hash → 图);sync 覆盖 messages 不影响", async () => {
    useUiStore.setState({ currentCwd: "/proj", currentSessionPath: "/s/a.jsonl", sessionModelPending: {} });
    await useSessionStore.getState().sendMessage("/proj", "ping", {
      image: { src: "~/.pi-desktop/s/a.gif", title: "ping" },
    });
    // 乐观记录:imageIndex["/s/a.jsonl"][hash("ping")] 存在
    const { contentHashOf } = await import("@pi-desktop/contract");
    const key = contentHashOf("ping");
    const idx = useSessionStore.getState().imageIndex;
    expect(idx["/s/a.jsonl"]?.[key]).toEqual({ src: "~/.pi-desktop/s/a.gif", title: "ping" });
    // 模拟 sync:onSnapshot 全量替换 messages——imageIndex 独立存活(不随 messages 被覆盖)
    const before = useSessionStore.getState().imageIndex;
    useSessionStore.setState({ messages: [{ id: "x", role: "assistant", content: "回复" } as never] });
    expect(useSessionStore.getState().imageIndex).toBe(before);
    expect(useSessionStore.getState().imageIndex["/s/a.jsonl"]?.[key]).toBeTruthy();
  });

  it("openSession 从文件读回(role:image)重建 imageIndex", async () => {
    const { contentHashOf } = await import("@pi-desktop/contract");
    // 模拟文件读回 detail:user + assistant + custom_message(image)
    const detail = {
      info: { cwd: "/proj", id: "s1" },
      messages: [
        { id: "u1", role: "user", content: "帮我整理日报" },
        { id: "a1", role: "assistant", content: "好的" },
        { id: "i1", role: "image", display: true, content: JSON.stringify({ src: "~/.pi-desktop/s/b.png" }) },
      ],
      stats: null,
    };
    (window as unknown as { pi: { sessions: { openSession: () => Promise<unknown> } } }).pi.sessions.openSession = async () => detail;
    useUiStore.setState({ currentCwd: "/proj", currentSessionPath: "/s/b.jsonl", sessionModelPending: {} });
    const ok = await useSessionStore.getState().openSession("/s/b.jsonl");
    expect(ok).toBe(true);
    const idx = useSessionStore.getState().imageIndex;
    expect(idx["/s/b.jsonl"]?.[contentHashOf("帮我整理日报")]).toEqual({ src: "~/.pi-desktop/s/b.png" });
  });
});
