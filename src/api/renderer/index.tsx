// renderer React 入口 —— 壳骨架:标题栏 + 布局引擎 + 设置覆盖层。
//
// activeView=chat:布局引擎驱动的动态界面;activeView=settings:设置整页覆盖。
// 壳只做机制:布局引擎、标题栏 chrome、快捷键、设置框架。
// 功能是插件:左栏分组(sidebar 槽)、右面板页签(sidePanel 槽)、设置子页(settings 槽)。
//
// 快捷键:⌘B 左栏、⌘J 右面板、⌘N 新会话、⌘, 设置(macOS 经典,Ctrl 等价于非 Mac)。
import { createRoot } from "react-dom/client";
import React, { memo, useEffect, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ThemeProvider } from "./theme-context";
import { initI18n, subscribeLocaleChange } from "./i18n-init";
import { Titlebar } from "./components/titlebar";
import { SidePanelStrip } from "./components/right-panel";
import { SettingsPage } from "./components/settings-page";
import { LayoutEngine, isLayoutDragging } from "./components/layout-engine";
import { useUiStore } from "./ui-store";
import { useLayoutStore } from "@pi-desktop/react";
import { useSessionStore, getLoadedPluginIds } from "@pi-desktop/react";
import { initSessionStore } from "@pi-desktop/react";
import { PluginOverlays, ErrorBoundary } from "@pi-desktop/react";
import { eventBus } from "@pi-desktop/react";
import type { ChannelMeta } from "@pi-desktop/contract";

// 视图导航 channel(框架自身归属,与插件 channel 同契约):keybindings 可绑定组合键
// 进入设置 / 返回对话。注册在模块加载期(先于任何 invoke),App 挂载时订阅切 activeView。
// pluginId 用 "shell"——invoke 只校验 channel 存在,不要求是"真插件",设置页动态列表照常列出。
eventBus.registerChannels("shell", ["shell:openSettings", "shell:backToChat"], {
  "shell:openSettings": {
    label: "打开设置",
    description: "切到设置视图(设置整页覆盖)。",
  },
  "shell:backToChat": {
    label: "返回对话",
    description: "从设置视图切回对话。",
  },
} satisfies Record<string, ChannelMeta>);

// ChatView/SettingsPage 都 memo:activeView 切换只翻两个 wrapper 的 visibility,
// 不允许父级重渲染级联进两棵大树(侧栏会话列表/时间线/右面板 + 设置页全部已挂载 pane)。
// 根因(实测 dev 50~200ms/次):切换时 App 重渲染曾 reconcile 双树全量组件;
// memo 后内部 zustand/i18next 订阅照常驱动自身更新,父级切换零成本。
const ChatView = memo(function ChatView(): React.ReactNode {
  return (
    <div className="h-full flex bg-[var(--color-bg)] text-[var(--color-fg)] font-[var(--font-family-sans)]">
      <LayoutEngine />
      <SidePanelStrip />
    </div>
  );
});

const MemoSettingsPage = memo(SettingsPage);

function App(): React.ReactNode {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const fontPreviewDragging = useUiStore((s) => s.fontPreviewDragging);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const sweepRafRef = useRef<number>(0);

  // 视图导航 channel 订阅:keybindings 绑定组合键 → invoke shell:openSettings/backToChat
  // → 这里切 activeView(setActiveView 是 zustand 稳定引用,effect 只挂一次)。
  useEffect(() => {
    const offA = eventBus.on("shell:openSettings", () => setActiveView("settings"));
    const offB = eventBus.on("shell:backToChat", () => setActiveView("chat"));
    return () => {
      offA();
      offB();
    };
  }, [setActiveView]);

  useEffect(() => {
    if (activeView === "settings") setSettingsMounted(true);
  }, [activeView]);

  // pluginsNonce 订阅:变化时同步 mainView 槽 + 清扫过期视图(§6.3, §4.3)
  useEffect(() => {
    const store = useLayoutStore.getState();

    // DRAG GUARD (§4.3): sweep 必须延迟到拖拽手势结束
    const doSweep = (): void => {
      if (isLayoutDragging()) {
        sweepRafRef.current = requestAnimationFrame(doSweep);
        return;
      }
      const ids = getLoadedPluginIds();
      store.sweepStaleViews(ids);
    };

    store.syncMainViewSlot();
    // sweep 延迟一轮确保 loaded ids 已就绪
    sweepRafRef.current = requestAnimationFrame(doSweep);

    return () => {
      if (sweepRafRef.current) cancelAnimationFrame(sweepRafRef.current);
    };
  }, [pluginsNonce]);

  // 字号 slider 拖动中:pointerup 兜底清理(鼠标可能离开 slider 再松手)
  useEffect(() => {
    const onUp = (): void => {
      if (useUiStore.getState().fontPreviewDragging) useUiStore.getState().setFontPreviewDragging(false);
    };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, []);

  // 全局快捷键:⌘B 左栏 / ⌘J 右面板 / ⌘N 新会话 / ⌘, 设置
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const layoutStore = useLayoutStore.getState();
      const uiStore = useUiStore.getState();
      if (e.key === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const leftGroup = (() => {
          const t = layoutStore.tree;
          if (t.kind !== "split") return null;
          for (const child of t.children) {
            if (child.kind === "group" && child.id === "left") return child;
          }
          return null;
        })();
        if (leftGroup) {
          layoutStore.setGroupHidden("left", !(leftGroup.hidden === true));
        }
      } else if (e.key === "j" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const rightGroup = (() => {
          const t = layoutStore.tree;
          if (t.kind !== "split") return null;
          for (const child of t.children) {
            if (child.kind === "group" && child.id === "right") return child;
          }
          return null;
        })();
        if (rightGroup) {
          layoutStore.setGroupHidden("right", !(rightGroup.hidden === true));
        }
      } else if (e.key === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        uiStore.setCurrentSessionPath(null);
        uiStore.setSessionTitle(null);
        void useSessionStore.getState().startNewChat(uiStore.currentCwd);
      } else if (e.key === ",") {
        e.preventDefault();
        setActiveView("settings");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setActiveView]);

  return (
    <div className="flex flex-col h-full">
      <Titlebar />
      <div className="relative flex-1 min-h-0">
        {/* 200ms 交叉淡入淡出是刻意的视觉打磨(保留);卡顿根因是切换时双树全量
            reconcile,已由 memo 双树解决——动画不再与 jank 叠加。visibility 而非
            display:保住 ChatView 布局与 virtuoso 滚动位置,切回零重排。 */}
        <div
          className="absolute inset-0"
          style={{
            opacity: activeView === "chat" || fontPreviewDragging ? 1 : 0,
            visibility: activeView === "chat" || fontPreviewDragging ? "visible" : "hidden",
            transition: "opacity 0.2s ease, visibility 0.2s",
          }}
        >
          <ChatView />
        </div>
        {settingsMounted && (
          <div
            className="absolute inset-0"
            style={{
              opacity: fontPreviewDragging ? 0.12 : (activeView === "settings" ? 1 : 0),
              visibility: activeView === "settings" || fontPreviewDragging ? "visible" : "hidden",
              transition: "opacity 0.2s ease, visibility 0.2s",
              pointerEvents: fontPreviewDragging ? "none" : "auto",
            }}
          >
            <MemoSettingsPage />
          </div>
        )}
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  const hydrateP = useUiStore.getState().hydrateFromPrefs().then(() => {
    const { currentCwd } = useUiStore.getState();
    if (currentCwd) void useSessionStore.getState().startNewChat(currentCwd);
  });
  // 布局 store hydrate:在 ui-store 之后——general.json 分层读(helper)要先恢复 cwd 镜像,
  // 否则冷启动读不到项目级覆盖(sidebarDefaultOpen 等)
  const layoutHydrateP = hydrateP.then(() => useLayoutStore.getState().hydrate());

  // 渲染闸门纳入 pluginsReady:插件组件注册完成才 render,
  // 否则槽宿主首渲染会闪"组件未注册"回退(manifest 已查到、组件还没 import 完)。
  // 单个插件加载失败在 plugins-host 内部已 catch 收敛,不阻塞;chunk 挂死由 5s race 兜底。
  const pluginsReadyP = import("./plugins-host")
    .then(({ pluginsReady }) => pluginsReady)
    .catch((err) => console.error("[plugins-host] 加载失败:", err));
  const timeoutP = new Promise<void>((r) => setTimeout(r, 5000));
  Promise.race([Promise.all([hydrateP, layoutHydrateP, initI18n(), pluginsReadyP]), timeoutP])
    .catch(() => {})
    .finally(() => {
      try {
        initSessionStore();
        subscribeLocaleChange();
        const root = createRoot(rootEl);
        root.render(
          <ThemeProvider>
            {/* Tooltip.Provider 全局唯一一份:Radix v1 要求 Tooltip.Root 位于 Provider 之下,
                由内核统一提供,任何插件(含 portal 内的 overlay)用 Tooltip 都不再需要自己包;
                delayDuration 等全局配置在此收敛,Root 可局部覆盖。 */}
            <Tooltip.Provider>
              <ErrorBoundary>
                <App />
                <PluginOverlays />
              </ErrorBoundary>
            </Tooltip.Provider>
          </ThemeProvider>,
        );
      } catch (err) {
        console.error("[index] render failed:", err);
        rootEl.innerHTML = '<div style="padding:32px;color:red">render failed: ' + String(err) + '</div>';
      }
    });
}
