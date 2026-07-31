// renderer React 入口 —— 壳骨架:标题栏 + 三栏(左 sidebar 槽 / 中 timeline / 右 sidePanel 槽)。
//
// activeView=chat:三栏对话界面;activeView=settings:设置整页覆盖。
// 壳只做机制:面板布局(PanelGroup)、标题栏 chrome、快捷键、设置框架。
// 功能是插件:左栏分组(sidebar 槽)、右面板页签(sidePanel 槽)、设置子页(settings 槽)。
//
// 快捷键:⌘B 左栏、⌘J 右面板、⌘N 新会话、⌘, 设置(macOS 经典,Ctrl 等价于非 Mac)。
import { createRoot } from "react-dom/client";
import React, { memo, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { ThemeProvider } from "./theme-context";
import { initI18n, subscribeLocaleChange } from "./i18n-init";
import { Titlebar } from "./components/titlebar";
import { Sidebar } from "./components/sidebar";
import { RightPanelContent, SidePanelStrip } from "./components/right-panel";
import { MainViewHost } from "./components/main-view-host";
import { SettingsPage } from "./components/settings-page";
import { useUiStore, SIDEBAR_MIN_PX, SIDEBAR_MAX_PX } from "./ui-store";
import { initSessionStore, useSessionStore } from "@pi-desktop/react";

// ChatView/SettingsPage 都 memo:activeView 切换只翻两个 wrapper 的 visibility,
// 不允许父级重渲染级联进两棵大树(侧栏会话列表/时间线/右面板 + 设置页全部已挂载 pane)。
// 根因(实测 dev 50~200ms/次):切换时 App 重渲染曾 reconcile 双树全量组件;
// memo 后内部 zustand/i18next 订阅照常驱动自身更新,父级切换零成本。
const ChatView = memo(function ChatView(): React.ReactNode {
  const leftPanelOpen = useUiStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);
  const layoutRef = useRef<number[]>([]);
  const pgRef = useRef<HTMLDivElement>(null);
  const [leftHandleDragging, setLeftHandleDragging] = useState(false);
  const [rightHandleDragging, setRightHandleDragging] = useState(false);
  // 开关动画:只在点开关时挂 transition(拖拽时不挂,保持 1:1 跟手)
  const [animating, setAnimating] = useState(false);

  const pgWidth = (): number => pgRef.current?.clientWidth ?? window.innerWidth;

  // 左栏宽度真相源在 ui-store(会话页/设置页共享):订阅变化 → imperative resize,
  // 设置页拖动时这边同步。折叠时不抢展开;expand 时按最新宽度恢复(见 leftPanelOpen effect)。
  useEffect(() => {
    const p = leftPanelRef.current;
    if (!p || p.isCollapsed()) return;
    p.resize((sidebarWidth / pgWidth()) * 100);
  }, [sidebarWidth]);

  // 面板开关状态 → imperative collapse/expand(store 是真相源,面板是被动的);
  // 开关触发 220ms 的 flex-basis transition 动画
  const animateToggle = (): void => {
    setAnimating(true);
    setTimeout(() => setAnimating(false), 240);
  };
  useEffect(() => {
    const p = leftPanelRef.current;
    if (!p) return;
    animateToggle();
    if (leftPanelOpen) {
      p.expand();
      // 折叠期间设置页可能拖过宽度:展开按最新共享宽度恢复
      p.resize((useUiStore.getState().sidebarWidth / pgWidth()) * 100);
    } else {
      p.collapse();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftPanelOpen]);
  useEffect(() => {
    const p = rightPanelRef.current;
    if (!p) return;
    animateToggle();
    if (rightPanelOpen) p.expand(); else p.collapse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightPanelOpen]);

  const onLeftHandleDragging = (dragging: boolean): void => {
    setLeftHandleDragging(dragging);
    if (!dragging && layoutRef.current.length > 0) {
      setSidebarWidth((layoutRef.current[0] / 100) * pgWidth());
    }
  };

  return (
    <div className="h-full flex bg-[var(--color-bg)] text-[var(--color-fg)] font-[var(--font-family-sans)]">
      <div ref={pgRef} className="h-full flex-1 min-w-0">
      <PanelGroup id="chat-pg" direction="horizontal" className="h-full" onLayout={(sizes) => { layoutRef.current = sizes; }}>
        <Panel
          ref={leftPanelRef}
          collapsible
          collapsedSize={0}
          defaultSize={(sidebarWidth / window.innerWidth) * 100}
          minSize={(SIDEBAR_MIN_PX / window.innerWidth) * 100}
          maxSize={(SIDEBAR_MAX_PX / window.innerWidth) * 100}
          className={animating ? "min-w-0 panel-collapse-anim" : "min-w-0"}
        >
          <Sidebar />
        </Panel>
        <PanelResizeHandle
          onDragging={onLeftHandleDragging}
          style={{
            width: "4px",
            cursor: "col-resize",
            background: leftHandleDragging ? "var(--color-primary)" : "transparent",
            transition: "background 0.15s",
          }}
        />
        {/* 中区:mainView 槽(评估 P1-C:timeline 插件贡献,壳只读槽渲染,不焊死时间线) */}
        <Panel className={animating ? "min-w-0 panel-collapse-anim" : "min-w-0"}>
          <div className="h-full flex flex-col">
            <MainViewHost />
          </div>
        </Panel>
        <PanelResizeHandle
          onDragging={setRightHandleDragging}
          style={{
            width: "4px",
            cursor: "col-resize",
            background: rightHandleDragging ? "var(--color-primary)" : "transparent",
            transition: "background 0.15s",
          }}
        />
        <Panel
          ref={rightPanelRef}
          collapsible
          collapsedSize={0}
          defaultSize={26}
          minSize={16}
          maxSize={50}
          className={animating ? "min-w-0 panel-collapse-anim" : "min-w-0"}
        >
          <RightPanelContent />
        </Panel>
      </PanelGroup>
      </div>
      <SidePanelStrip />
    </div>
  );
});

const MemoSettingsPage = memo(SettingsPage);

function App(): React.ReactNode {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const [settingsMounted, setSettingsMounted] = useState(false);
  useEffect(() => {
    if (activeView === "settings") setSettingsMounted(true);
  }, [activeView]);

  // 全局快捷键:⌘B 左栏 / ⌘J 右面板 / ⌘N 新会话 / ⌘, 设置
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const s = useUiStore.getState();
      if (e.key === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        s.setLeftPanelOpen(!s.leftPanelOpen);
      } else if (e.key === "j" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        s.setRightPanelOpen(!s.rightPanelOpen);
      } else if (e.key === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        s.setCurrentSessionPath(null);
        s.setSessionTitle(null);
        void useSessionStore.getState().startNewChat(s.currentCwd);
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
        {/* 视图切换零动画:原 200ms opacity/visibility 交叉淡入淡出被用户感知为"卡",
            且 visibility 延迟隐藏让旧视图多停一帧;即时翻转才是秒切。visibility 而非
            display:保住 ChatView 布局与 virtuoso 滚动位置,切回零重排。 */}
        <div
          className="absolute inset-0"
          style={{ visibility: activeView === "chat" ? "visible" : "hidden" }}
        >
          <ChatView />
        </div>
        {settingsMounted && (
          <div
            className="absolute inset-0"
            style={{ visibility: activeView === "settings" ? "visible" : "hidden" }}
          >
            <MemoSettingsPage />
          </div>
        )}
      </div>
    </div>
  );
}

/** ErrorBoundary:子组件抛错不拖垮整树,显示错误信息而非白屏。 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }
  render(): React.ReactNode {
    if (this.state.error) {
      return <div style={{ padding: 32, color: "red", fontFamily: "monospace", fontSize: 14 }}>
        渲染错误: {String(this.state.error.message)}
      </div>;
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (rootEl) {
  const hydrateP = useUiStore.getState().hydrateFromPrefs().then(() => {
    const { currentCwd } = useUiStore.getState();
    if (currentCwd) void useSessionStore.getState().startNewChat(currentCwd);
  });
  // 渲染闸门纳入 pluginsReady:插件组件注册完成才 render,
  // 否则槽宿主首渲染会闪"组件未注册"回退(manifest 已查到、组件还没 import 完)。
  // 单个插件加载失败在 plugins-host 内部已 catch 收敛,不阻塞;chunk 挂死由 5s race 兜底。
  const pluginsReadyP = import("./plugins-host")
    .then(({ pluginsReady }) => pluginsReady)
    .catch((err) => console.error("[plugins-host] 加载失败:", err));
  const timeoutP = new Promise<void>((r) => setTimeout(r, 5000));
  Promise.race([Promise.all([hydrateP, initI18n(), pluginsReadyP]), timeoutP])
    .catch(() => {})
    .finally(() => {
      try {
        initSessionStore();
        subscribeLocaleChange();
        const root = createRoot(rootEl);
        root.render(
          <ThemeProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </ThemeProvider>,
        );
      } catch (err) {
        console.error("[index] render failed:", err);
        rootEl.innerHTML = '<div style="padding:32px;color:red">render failed: ' + String(err) + '</div>';
      }
    });
}
