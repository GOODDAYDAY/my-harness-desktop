// renderer UI 状态 —— shell 层的轻量 UI 状态(zustand)+ 桌面偏好持久化。
//
// 依据 docs/structure/17 §1.3.1(zustand 做 UI 状态)+ 06 §7(主题/字体是桌面偏好,
// 走 electron-store,不进 pi settings、不进 plugins-data)。
// 这是 shell 细节:主题/字体偏好是 UI 交互态,非业务契约。
// 持久化:启动从 pi.prefs 读(经 main → electron-store),setter 调 pi.prefs.set 落盘,
// 跨重启保持(用户目标:不希望每次重启重新设置)。
// general.json(项目性质偏好:defaultThinkingLevel 等)走分层 helper
// (general-config.ts)——项目级覆盖全局,见 unified-project-config.md §5.4。
// 模型/思考深度的归属已翻转(设计 docs/design/session-model-config.md):真相在会话进程
// 与头行 model 域,这里只剩 onSend 意图的内存 pending——本 store 不再有全局"当前模型"。
import { create } from "zustand";
import type { SidebarStyle, SidepanelStyle, SessionToolConfig, SessionModelPrefs } from "@pi-desktop/contract";
import { GENERAL_CONFIG_PATH } from "@pi-desktop/contract";
import type { EchoAttachment } from "./session-store";
import { useLayoutStore } from "./layout-store";
import { readGeneralConfig, setGeneralConfigCwd } from "./general-config";
import { eventBus } from "../../../../packages/react/src/event-bus";

/** 主界面视图:对话页 / 设置页(整页覆盖)。
 *  评估 P1-C:原字段名 mainView 与"mainView 槽"(中区主视图槽)同名混淆,改 activeView。 */
export type AppView = "chat" | "settings";

/** 等宽字体偏好(系统栈预设值,覆盖 --font-family-mono) */
export type FontMonoChoice = "jetbrains" | "fira" | "cascadia" | "sfmono" | "menlo" | "system";

/** 正文调性(覆盖 --font-family-sans) */
export type FontSansTone = "sans" | "serif" | "mono" | "rounded";

/** 桌面偏好持久化的字段集(与 main 的 Prefs 对齐)。 */
const PREF_KEYS = {
  currentThemeId: "currentThemeId",
  timelineThemeId: "timelineThemeId",
  fontScale: "fontScale",
  fontMonoChoice: "fontMonoChoice",
  fontSansTone: "fontSansTone",
  sidebarStyle: "sidebarStyle",
  sidepanelStyle: "sidepanelStyle",
  sidebarWidth: "sidebarWidth",
  sidebarFontScale: "sidebarFontScale",
  sidepanelFontScale: "sidepanelFontScale",
  timelineFontScale: "timelineFontScale",
  activeSidePanelTabs: "activeSidePanelTabs",
  sidePanelOrder: "sidePanelOrder",
  lastCwd: "lastCwd",
  currentLocale: "currentLocale",
} as const;

export const SIDEBAR_MIN_PX = 180;
export const SIDEBAR_MAX_PX = 500;
export const SIDEBAR_DEFAULT_PX = 260;

export const AREA_FONT_SCALE_MIN = 0.5;
export const AREA_FONT_SCALE_MAX = 2.0;

const clampSidebarWidth = (px: number): number =>
  Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, Math.round(px)));

const clampAreaFontScale = (scale: number): number =>
  Math.max(AREA_FONT_SCALE_MIN, Math.min(AREA_FONT_SCALE_MAX, Math.round(scale * 100) / 100));

/** 排队消息(streaming 时按发送暂存,AI 完成后合并成一条自动 flush)。
 *  按 sessionKey 绑定(活会话=sessionPath,新会话壳=`new:${cwd}`),切会话互不可见。
 *  内存态不持久化——没 flush 就没发出,刷新丢失可接受。 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** 空文本项(纯评论入队)的篮内显示文案;由调用方用 t() 算好,store 不持有文案。 */
  displayText?: string;
  /** 入队瞬间的评论附件快照:flush 时活篮子已被消费/清空则回落它,排队意图不漂。 */
  attachments?: {
    items?: EchoAttachment[];
    promptFragment?: string;
    channels?: Record<string, string>;
  };
  failed?: boolean;
  errMsg?: string;
}

export interface UiState {
  /** 当前主题 id,决定 ThemeProvider 解析哪个主题 */
  currentThemeId: string;
  /** 会话流独立主题 id("__inherit__"=跟随全局) */
  timelineThemeId: string;
  /** 字号倍率,1.0 = 主题原值 */
  fontScale: number;
  /** 等宽字体偏好 */
  fontMonoChoice: FontMonoChoice;
  /** 正文调性 */
  fontSansTone: FontSansTone;
  /** 左栏风格 */
  sidebarStyle: SidebarStyle;
  /** 左栏宽度(px,会话页/设置页共享真相源:一边拖动,两边订阅同步) */
  sidebarWidth: number;
  /** 左栏字体倍率(1.0 = 主题原值,覆盖 --font-size-* 仅作用于左栏子树) */
  sidebarFontScale: number;
  /** 右面板字体倍率(同上,仅作用于右面板子树) */
  sidepanelFontScale: number;
  /** 会话流字体倍率(同上,仅作用于中区 timeline 子树) */
  timelineFontScale: number;
  /** 字号 slider 拖动中:设置页半透明,露出会话页实时预览 */
  fontPreviewDragging: boolean;
  /** 右面板风格 */
  sidepanelStyle: SidepanelStyle;
  /** 主界面视图(评估 P1-C:原 mainView,改名 activeView 避免与 mainView 槽混淆) */
  activeView: AppView;
  /** 当前工作目录(pi 子进程的 cwd,决定会话在哪个桶) */
  currentCwd: string;
  /** 当前会话文件路径(switch_session 后更新) */
  currentSessionPath: string | null;
  /** 右面板激活的面板 id 列表(最多 3 个同时可见,纵向堆叠) */
  activeSidePanelTabs: string[];
  /** 右面板图标条自定义排序(prefs 全局,Strip 拖拽写入;空数组 = 默认槽位序) */
  sidePanelOrder: string[];
  /** 当前会话标题(面包屑用;null → "新对话") */
  sessionTitle: string | null;
  /** 会话世代号:newSession/切会话/切目录时 +1,timeline 依赖它重 resync */
  sessionNonce: number;
  /** 插件注册世代号:plugins-host 加载完成 +1,槽壳(sidebar/右面板/设置页)依赖它重渲染查组件 */
  pluginsNonce: number;
  /** 是否已从 prefs 加载完(初始 false,加载完 true,避免闪烁) */
  hydrated: boolean;
  /** 当前界面 locale(zh-CN/zh-TW/en/de),决定 i18next 查哪套文案 */
  currentLocale: string;
  /** general.json 分层合并视图(项目级覆盖全局);框架级偏好的单源,插件只读 */
  generalConfig: Record<string, unknown>;
  /** 模型/深度的待执行意图(onSend 模式点选暂存,send 回灌执行后清空;设计 §4.1/§4.5)。
   *  按会话 key 暂存:活会话=sessionPath,新会话壳=`new:${cwd}`。内存态不持久化——
   *  没 send 就没生效,没生效的选择不留任何持久痕迹(RPC 拒绝时保留,只有执行成功才消费)。 */
  sessionModelPending: Record<string, SessionModelPrefs>;
  /** 会话级工具过滤的未落盘偏好(tool-manager 组开关只写这里,timeline send() 才 flush 到头行——
   *  与 composerApplyTiming 的"偏好/落盘"两态同语义)。绑定 sessionPath:A 会话偏好不许误 flush 到 B。
   *  flushed=true 已落盘,留存只为 ToolPanelTab 显示不跳变,send() 跳过。config=null = 切回全部工具。 */
  pendingToolConfig: { sessionPath: string; config: SessionToolConfig | null; flushed: boolean } | null;
  /** 排队消息队列(streaming 时按发送暂存,AI 完成后合并 flush)。 */
  pendingQueue: Record<string, QueuedMessage[]>;
  setCurrentThemeId: (id: string) => void;
  setTimelineThemeId: (id: string) => void;
  setFontScale: (scale: number) => void;
  setFontMonoChoice: (choice: FontMonoChoice) => void;
  setFontSansTone: (tone: FontSansTone) => void;
  setSidebarStyle: (style: SidebarStyle) => void;
  setSidebarWidth: (px: number) => void;
  setSidebarFontScale: (scale: number) => void;
  setSidepanelFontScale: (scale: number) => void;
  setTimelineFontScale: (scale: number) => void;
  setFontPreviewDragging: (dragging: boolean) => void;
  setSidepanelStyle: (style: SidepanelStyle) => void;
  /** 切界面 locale:落 prefs + 通知 i18next changeLanguage(由调用方接 react-i18next) */
  setCurrentLocale: (locale: string) => void;
  /** 暂存/更新某会话的模型意图(整体替换该 key 的三字段)。 */
  setSessionModelPending: (key: string, prefs: SessionModelPrefs) => void;
  /** 消费某会话的模型意图(send 回灌执行成功后调)。 */
  clearSessionModelPending: (key: string) => void;
  enqueueMessage: (key: string, text: string, attachments?: QueuedMessage["attachments"], displayText?: string) => void;
  removeFromQueue: (key: string, id: string) => void;
  clearQueue: (key: string) => void;
  /** 整队标失败(flush 失败后保留全部,用户重试/逐条编辑/取消)。 */
  markQueueFailed: (key: string, errMsg: string) => void;
  /** 清失败标记(重试前调,不删条目)。 */
  clearQueueFailed: (key: string) => void;
  /** 重读 general.json 分层合并视图(cwd 切换/写后广播时调) */
  reloadGeneralConfig: () => Promise<void>;
  setPendingToolConfig: (p: { sessionPath: string; config: SessionToolConfig | null; flushed: boolean } | null) => void;
  setActiveView: (view: AppView) => void;
  setCurrentCwd: (cwd: string) => void;
  setCurrentSessionPath: (path: string | null) => void;
  toggleSidePanelTab: (id: string) => void;
  /** 揭示语义(幂等):tab 不在活跃集则补入,右面板组确保展开——
   *  与 toggle 的区别是不做反向关闭,供 revealOn 声明式揭示用。 */
  activateSidePanelTab: (id: string) => void;
  /** 清理已从槽清单消失的死 tab id(插件卸载/禁用后由 Strip 在清单刷新时触发)。
   *  幂等:无死 id 返回原引用。尚有剩余贡献项时不折叠——交给 Strip 兜底
   *  effect 自动激活第一个;清单整体消失(没有任何可激活项)才折叠 right 组。 */
  pruneSidePanelTabs: (validIds: string[]) => void;
  /** 写右面板图标条自定义排序(Strip 拖拽落点):内存 + prefs 同步,全局生效。 */
  setSidePanelOrder: (order: string[]) => void;
  setSessionTitle: (title: string | null) => void;
  bumpSession: () => void;
  bumpPlugins: () => void;
  hydrateFromPrefs: () => Promise<void>;
}

export const useUiStore = create<UiState>((set, get) => ({
  currentThemeId: "chatgpt-dark",
  timelineThemeId: "__inherit__",
  fontScale: 1.0,
  fontMonoChoice: "jetbrains",
  fontSansTone: "sans",
  sidebarStyle: "default",
  sidebarWidth: SIDEBAR_DEFAULT_PX,
  sidebarFontScale: 1.0,
  sidepanelFontScale: 1.0,
  timelineFontScale: 1.0,
  fontPreviewDragging: false,
  sidepanelStyle: "default",
  currentLocale: "zh-CN",
  generalConfig: {},
  sessionModelPending: {},
  pendingToolConfig: null,
  pendingQueue: {},
  activeView: "chat",
  currentCwd: "",
  currentSessionPath: null,
  activeSidePanelTabs: [],
  sidePanelOrder: [],
  sessionTitle: null,
  sessionNonce: 0,
  pluginsNonce: 0,
  hydrated: false,
  setCurrentThemeId: (id) => {
    set({ currentThemeId: id });
    void window.pi.prefs.set(PREF_KEYS.currentThemeId, id);
  },
  setTimelineThemeId: (id) => {
    set({ timelineThemeId: id });
    void window.pi.prefs.set(PREF_KEYS.timelineThemeId, id);
  },
  setFontScale: (scale) => {
    set({ fontScale: scale });
    void window.pi.prefs.set(PREF_KEYS.fontScale, scale);
  },
  setFontMonoChoice: (choice) => {
    set({ fontMonoChoice: choice });
    void window.pi.prefs.set(PREF_KEYS.fontMonoChoice, choice);
  },
  setFontSansTone: (tone) => {
    set({ fontSansTone: tone });
    void window.pi.prefs.set(PREF_KEYS.fontSansTone, tone);
  },
  setSidebarStyle: (style) => {
    set({ sidebarStyle: style });
    void window.pi.prefs.set(PREF_KEYS.sidebarStyle, style);
  },
  setSidebarWidth: (px) => {
    const w = clampSidebarWidth(px);
    set({ sidebarWidth: w });
    void window.pi.prefs.set(PREF_KEYS.sidebarWidth, w);
  },
  setSidebarFontScale: (scale) => {
    const s = clampAreaFontScale(scale);
    set({ sidebarFontScale: s });
    void window.pi.prefs.set(PREF_KEYS.sidebarFontScale, s);
  },
  setSidepanelFontScale: (scale) => {
    const s = clampAreaFontScale(scale);
    set({ sidepanelFontScale: s });
    void window.pi.prefs.set(PREF_KEYS.sidepanelFontScale, s);
  },
  setTimelineFontScale: (scale) => {
    const s = clampAreaFontScale(scale);
    set({ timelineFontScale: s });
    void window.pi.prefs.set(PREF_KEYS.timelineFontScale, s);
  },
  setFontPreviewDragging: (dragging) => set({ fontPreviewDragging: dragging }),
  setSidepanelStyle: (style) => {
    set({ sidepanelStyle: style });
    void window.pi.prefs.set(PREF_KEYS.sidepanelStyle, style);
  },
  setCurrentLocale: (locale) => {
    set({ currentLocale: locale });
    void window.pi.prefs.set(PREF_KEYS.currentLocale, locale);
  },
  setSessionModelPending: (key, prefs) =>
    set((s) => ({ sessionModelPending: { ...s.sessionModelPending, [key]: prefs } })),
  clearSessionModelPending: (key) =>
    set((s) => {
      if (!(key in s.sessionModelPending)) return s;
      const next = { ...s.sessionModelPending };
      delete next[key];
      return { sessionModelPending: next };
    }),
  enqueueMessage: (key, text, attachments, displayText) =>
    set((s) => ({
      pendingQueue: {
        ...s.pendingQueue,
        [key]: [...(s.pendingQueue[key] ?? []), { id: crypto.randomUUID(), text, attachments, displayText }],
      },
    })),
  removeFromQueue: (key, id) =>
    set((s) => {
      const cur = s.pendingQueue[key];
      if (!cur) return s;
      const nextList = cur.filter((q) => q.id !== id);
      const next = { ...s.pendingQueue };
      if (nextList.length === 0) delete next[key]; else next[key] = nextList;
      return { pendingQueue: next };
    }),
  clearQueue: (key) =>
    set((s) => {
      if (!(key in s.pendingQueue)) return s;
      const next = { ...s.pendingQueue };
      delete next[key];
      return { pendingQueue: next };
    }),
  markQueueFailed: (key, errMsg) =>
    set((s) => {
      const cur = s.pendingQueue[key];
      if (!cur) return s;
      return {
        pendingQueue: {
          ...s.pendingQueue,
          [key]: cur.map((q) => ({ ...q, failed: true, errMsg })),
        },
      };
    }),
  clearQueueFailed: (key) =>
    set((s) => {
      const cur = s.pendingQueue[key];
      if (!cur) return s;
      return {
        pendingQueue: {
          ...s.pendingQueue,
          [key]: cur.map((q) => ({ ...q, failed: false, errMsg: undefined })),
        },
      };
    }),
  reloadGeneralConfig: async () => {
    const cfg = await readGeneralConfig();
    set({ generalConfig: cfg });
  },
  setPendingToolConfig: (p) => set({ pendingToolConfig: p }),
  setActiveView: (view) => set({ activeView: view }),
  setCurrentCwd: (cwd) => {
    set({ currentCwd: cwd });
    void window.pi.prefs.set(PREF_KEYS.lastCwd, cwd);
    setGeneralConfigCwd(cwd);
    // 项目层随 cwd 切换:general.json 分层视图重读(项目级覆盖换到新项目)
    void get().reloadGeneralConfig();
  },
  setCurrentSessionPath: (path) => set({ currentSessionPath: path }),
  // 右面板 tab 开关与 right 组显隐同生共死:tabs 清空即折叠,有 tab 即展开。
  // 显隐真相源在 layout store(树 right 组的 hidden),这里只维护 tab 列表与 prefs。
  toggleSidePanelTab: (id) => set((s) => {
    const tabs = s.activeSidePanelTabs;
    const next = tabs.includes(id) ? tabs.filter((t) => t !== id) : [...tabs, id];
    void window.pi.prefs.set(PREF_KEYS.activeSidePanelTabs, next);
    useLayoutStore.getState().setGroupHidden("right", next.length === 0);
    return { activeSidePanelTabs: next };
  }),
  activateSidePanelTab: (id) => set((s) => {
    const tabs = s.activeSidePanelTabs;
    const next = tabs.includes(id) ? tabs : [...tabs, id];
    if (next !== tabs) void window.pi.prefs.set(PREF_KEYS.activeSidePanelTabs, next);
    useLayoutStore.getState().setGroupHidden("right", false);
    return next === tabs ? s : { activeSidePanelTabs: next };
  }),
  pruneSidePanelTabs: (validIds) => set((s) => {
    const valid = new Set(validIds);
    const next = s.activeSidePanelTabs.filter((id) => valid.has(id));
    if (next.length === s.activeSidePanelTabs.length) return s;
    void window.pi.prefs.set(PREF_KEYS.activeSidePanelTabs, next);
    if (next.length === 0 && validIds.length === 0) {
      useLayoutStore.getState().setGroupHidden("right", true);
    }
    return { activeSidePanelTabs: next };
  }),
  setSidePanelOrder: (order) => {
    set({ sidePanelOrder: order });
    void window.pi.prefs.set(PREF_KEYS.sidePanelOrder, order);
  },
  setSessionTitle: (title) => set({ sessionTitle: title }),
  bumpSession: () => set((s) => ({ sessionNonce: s.sessionNonce + 1 })),
  bumpPlugins: () => set((s) => ({ pluginsNonce: s.pluginsNonce + 1 })),
  hydrateFromPrefs: async () => {
    // electron-store 构造时已设 defaults(见 main 的 DEFAULT_PREFS),prefs.get 必返回值、
    // 不会是 undefined;故不需 ?? 兜底(盲审 F4:删死代码,承认 electron-store defaults 兜底)。
    // rightPanelOpen 已迁到 layout store(layout-store hydrate 自行从 prefs 读),ui-store 不再管。
    // leftPanelOpen/sidebarDefaultOpen: layout-store hydrate 从 general-config 读,ui-store 不再管。
    const [currentThemeId, fontScale, fontMonoChoice, fontSansTone, sidebarStyle, sidebarWidth, sidebarFontScale, sidepanelFontScale, timelineFontScale, sidepanelStyle, activeSidePanelTabs, sidePanelOrder, lastCwd, currentLocale, timelineThemeId] = await Promise.all([
      window.pi.prefs.get<string>(PREF_KEYS.currentThemeId),
      window.pi.prefs.get<number>(PREF_KEYS.fontScale),
      window.pi.prefs.get<string>(PREF_KEYS.fontMonoChoice),
      window.pi.prefs.get<string>(PREF_KEYS.fontSansTone),
      window.pi.prefs.get<string>(PREF_KEYS.sidebarStyle),
      window.pi.prefs.get<number>(PREF_KEYS.sidebarWidth),
      window.pi.prefs.get<number>(PREF_KEYS.sidebarFontScale),
      window.pi.prefs.get<number>(PREF_KEYS.sidepanelFontScale),
      window.pi.prefs.get<number>(PREF_KEYS.timelineFontScale),
      window.pi.prefs.get<string>(PREF_KEYS.sidepanelStyle),
      window.pi.prefs.get<string[]>(PREF_KEYS.activeSidePanelTabs),
      window.pi.prefs.get<string[]>(PREF_KEYS.sidePanelOrder),
      window.pi.prefs.get<string>(PREF_KEYS.lastCwd),
      window.pi.prefs.get<string>(PREF_KEYS.currentLocale),
      window.pi.prefs.get<string>(PREF_KEYS.timelineThemeId),
    ]);
    const cwd = lastCwd || "";
    // general.json 分层读要在 cwd 恢复之后(项目级覆盖按当前项目解析)
    setGeneralConfigCwd(cwd);
    const generalConfig = await readGeneralConfig(cwd);
    // 一次性迁移(2026-08 全局化):sidePanelOrder 曾误落 general.json 项目级(按项目分层,
    // 与"桌面 UI 偏好"语义相悖),迁至 prefs 全局。prefs 已有值不覆盖;general.json 残留键
    // 无害(读侧已不消费,无删键原语,不值得为它加)。
    const orderFromPrefs = Array.isArray(sidePanelOrder) ? sidePanelOrder : [];
    const legacyOrder = generalConfig["sidePanelOrder"];
    const effectiveSidePanelOrder =
      orderFromPrefs.length > 0
        ? orderFromPrefs
        : Array.isArray(legacyOrder) && legacyOrder.length > 0
          ? (legacyOrder as string[])
          : [];
    if (orderFromPrefs.length === 0 && effectiveSidePanelOrder.length > 0) {
      void window.pi.prefs.set(PREF_KEYS.sidePanelOrder, effectiveSidePanelOrder);
    }
    set({
      currentThemeId,
      fontScale,
      fontMonoChoice: fontMonoChoice as FontMonoChoice,
      fontSansTone: fontSansTone as FontSansTone,
      sidebarStyle: (sidebarStyle ?? "default") as SidebarStyle,
      sidebarWidth: clampSidebarWidth(sidebarWidth),
      sidebarFontScale: clampAreaFontScale(sidebarFontScale),
      sidepanelFontScale: clampAreaFontScale(sidepanelFontScale),
      timelineFontScale: clampAreaFontScale(timelineFontScale),
      sidepanelStyle: (sidepanelStyle ?? "default") as SidepanelStyle,
      activeSidePanelTabs: Array.isArray(activeSidePanelTabs) ? activeSidePanelTabs : [],
      sidePanelOrder: effectiveSidePanelOrder,
      currentCwd: cwd,
      currentLocale: currentLocale || "zh-CN",
      generalConfig,
      timelineThemeId: timelineThemeId || "__inherit__",
      hydrated: true,
    });
  },
}));

// general.json 写后重读:设置页"确定改动/设为全局"和 helper 写后都广播 configFileSaved。
// 模块级订阅(store 与 app 同生命周期,无需清理);只重读 general.json,别的事件不关心。
eventBus.on("system:configFileSaved", (payload) => {
  if ((payload as { path?: string })?.path === GENERAL_CONFIG_PATH) {
    void useUiStore.getState().reloadGeneralConfig();
  }
});
