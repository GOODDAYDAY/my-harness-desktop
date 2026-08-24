// 桌面自持图存储(imageIndex)的运行时验证:
// 发送乐观写(sendText hash 锚) → entryAppended 升级为 entryId 锚 → openSession 存量兼容 → 独立于底座快照。
// mock window.pi(不含 Electron),验证桌面侧图片索引生命周期。
import { describe, it, expect, beforeEach } from "vitest";
import { contentHashOf } from "@my-harness-desktop/contract";
import { useUiStore } from "./ui-store";
import { useSessionStore, initSessionStore, applySnapshot } from "./session-store";

type EventHandler = (e: Record<string, unknown>) => void;

const calls = {
  append: [] as { path: string; entry: Record<string, unknown> }[],
  setConfig: [] as { path: string; data: unknown }[],
};

let eventCb: EventHandler | null = null;
const fileStore = new Map<string, unknown>();

function mockWindow(): void {
  calls.append = [];
  calls.setConfig = [];
  fileStore.clear();
  eventCb = null;
  (globalThis as unknown as { window: unknown }).window = {
    pi: {
      sessions: {
        setContext: async () => {},
        prompt: async () => {},
        sync: async () => ({}),
        setModel: async () => {},
        setThinkingLevel: async () => {},
        updateHeader: async () => ({}),
        readToolConfig: async () => null,
        openSession: async () => null,
        list: async () => [],
        getStats: async () => null,
        getThinkingLevels: async () => [],
        getCapabilities: async () => ({ piExtension: true, dshExtension: false }),
        onEvent: (cb: EventHandler) => { eventCb = cb; return () => {}; },
        onSnapshot: () => () => {},
        onKernelEvent: () => () => {},
        onQuestion: () => () => {},
        answerQuestion: async () => {},
      },
      piSettings: { get: async () => ({}), set: async () => ({}), schema: async () => [] },
      models: { get: async () => ({}), set: async () => ({}), getFallbackModel: async () => null },
      kernel: { toolgateAvailable: async () => true, status: async () => ({ available: true }) },
      configFile: {
        readBinary: async () => "YQ==",
        append: async (p: string, e: Record<string, unknown>) => { calls.append.push({ path: p, entry: e }); },
        set: async (p: string, d: unknown) => { calls.setConfig.push({ path: p, data: d }); fileStore.set(p, d); },
        get: async (p: string) => fileStore.get(p),
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
  useSessionStore.setState({ messages: [], snapshot: null, imageIndex: {} });
  initSessionStore();
});

describe("桌面自持图存储(imageIndex)", () => {
  it("发送带图 → 乐观写 imageIndex(sendText hash 锚),且不 append custom_message 到底座文件", async () => {
    await useSessionStore.getState().sendMessage("/proj", "ping", {
      image: { src: "~/.my-harness-desktop/s/a.gif", title: "ping" },
    });
    // 乐观 __image 挂 user 上
    expect(useSessionStore.getState().messages.some((m) => m.role === "user" && (m as { __image?: unknown }).__image)).toBe(true);
    // 桌面图存储记录:临时锚 = sendText hash
    const key = contentHashOf("ping");
    // 新会话 currentSessionPath null → 锚记在 new:/proj 下
    const idx = useSessionStore.getState().imageIndex;
    const found = Object.values(idx).some((per) => per[key]);
    expect(found).toBe(true);
    // 不再写底座会话文件(custom_message)
    expect(calls.append.some((a) => a.entry.type === "custom_message")).toBe(false);
  });

  it("entryAppended 水合出 entryId 后,临时锚升级为 id 锚", async () => {
    useUiStore.setState({ currentSessionPath: "/s/a.jsonl", currentCwd: "/proj" });
    await useSessionStore.getState().sendMessage("/proj", "ping", {
      image: { src: "~/.my-harness-desktop/s/a.gif", title: "ping" },
    });
    const hashKey = contentHashOf("ping");
    expect(useSessionStore.getState().imageIndex["/s/a.jsonl"]?.[hashKey]).toBeTruthy();
    // 升级锚(直接调 action,不依赖 onEvent 注册时序)
    useSessionStore.getState().hydrateImageAnchor("/s/a.jsonl", "ping", "m1");
    const idx = useSessionStore.getState().imageIndex;
    expect(idx["/s/a.jsonl"]?.["m1"]).toBeTruthy(); // id 锚
    expect(idx["/s/a.jsonl"]?.[hashKey]).toBeUndefined(); // 临时锚已删
  });

  it("openSession 从存量 role:image 条目建锚(user.id),兼容老会话", async () => {
    const detail = {
      info: { cwd: "/proj", id: "s1" },
      messages: [
        { id: "u1", role: "user", content: "ping" },
        { id: "a1", role: "assistant", content: "ok" },
        { id: "i1", role: "image", display: true, content: JSON.stringify({ src: "~/.my-harness-desktop/s/b.png" }) },
      ],
      stats: null,
    };
    (window as unknown as { pi: { sessions: { openSession: () => Promise<unknown> } } }).pi.sessions.openSession = async () => detail;
    useUiStore.setState({ currentCwd: "/proj", currentSessionPath: "/s/b.jsonl", sessionModelPending: {} });
    await useSessionStore.getState().openSession("/s/b.jsonl");
    expect(useSessionStore.getState().imageIndex["/s/b.jsonl"]?.["u1"]).toEqual({ src: "~/.my-harness-desktop/s/b.png" });
  });

  it("sync 覆盖 messages 不影响 imageIndex(图展示独立于底座快照)", async () => {
    useUiStore.setState({ currentSessionPath: "/s/a.jsonl", currentCwd: "/proj" });
    await useSessionStore.getState().sendMessage("/proj", "ping", { image: { src: "~/.my-harness-desktop/s/a.gif" } });
    const before = useSessionStore.getState().imageIndex;
    // 模拟 sync:onSnapshot 全量替换 messages
    useSessionStore.setState({ messages: [{ id: "x", role: "assistant", content: "回复" } as never] });
    expect(useSessionStore.getState().imageIndex).toBe(before);
    expect(useSessionStore.getState().imageIndex["/s/a.jsonl"]?.[contentHashOf("ping")]).toBeTruthy();
  });

  it("发送带图 → 立即 persist 到 session-images.json(乐观写不等 entryAppended)", async () => {
    useUiStore.setState({ currentSessionPath: "/s/a.jsonl", currentCwd: "/proj" });
    await useSessionStore.getState().sendMessage("/proj", "ping", {
      image: { src: "~/.my-harness-desktop/s/a.gif", title: "ping" },
    });
    const persist = calls.setConfig.filter((c) => c.path === "~/.my-harness-desktop/stickers/session-images.json");
    expect(persist.length).toBeGreaterThan(0);
    const doc = persist[persist.length - 1].data as Record<string, unknown>;
    expect(doc["/s/a.jsonl"]).toMatchObject({ [contentHashOf("ping")]: { src: "~/.my-harness-desktop/s/a.gif", title: "ping" } });
  });

  it("pruneImageIndex 删除会话的孤儿图记录并 persist", async () => {
    useUiStore.setState({ currentSessionPath: "/s/a.jsonl", currentCwd: "/proj" });
    await useSessionStore.getState().sendMessage("/proj", "ping", { image: { src: "~/.my-harness-desktop/s/a.gif" } });
    expect(useSessionStore.getState().imageIndex["/s/a.jsonl"]).toBeTruthy();
    useSessionStore.getState().pruneImageIndex(["/s/a.jsonl"]);
    expect(useSessionStore.getState().imageIndex["/s/a.jsonl"]).toBeUndefined();
    const persist = calls.setConfig.filter((c) => c.path === "~/.my-harness-desktop/stickers/session-images.json");
    const doc = persist[persist.length - 1].data as Record<string, unknown>;
    expect(doc["/s/a.jsonl"]).toBeUndefined();
  });

  it("新会话首条图消息:adoptSessionImages 把 new:<cwd> 占位键迁到真实路径", async () => {
    useUiStore.setState({ currentSessionPath: null, currentCwd: "/proj" });
    await useSessionStore.getState().sendMessage("/proj", "", { image: { src: "~/.my-harness-desktop/s/a.gif" } });
    const hashKey = contentHashOf("");
    // 首条消息:currentSessionPath 尚为 null,锚记在 new:/proj 占位键
    expect(useSessionStore.getState().imageIndex["new:/proj"]?.[hashKey]).toBeTruthy();
    // sessionStart 拿到真实路径 → 占位键迁走
    useSessionStore.getState().adoptSessionImages("/proj", "/s/a.jsonl");
    expect(useSessionStore.getState().imageIndex["new:/proj"]).toBeUndefined();
    expect(useSessionStore.getState().imageIndex["/s/a.jsonl"]?.[hashKey]).toEqual({ src: "~/.my-harness-desktop/s/a.gif" });
  });

  it("applySnapshot:空快照不冲掉乐观消息(首图锚定不被 warmup 的 start sync 清掉)", () => {
    const s = useSessionStore.getState();
    const optimistic = { id: "tmp1", role: "user", content: "你好", __optimistic: true } as never;
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
