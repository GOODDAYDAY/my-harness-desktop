// renderer React 入口 —— 壳骨架:标题栏 + 三栏(左 sidebar 槽 / 中 timeline / 右 sidePanel 槽)。
//
// activeView=chat:三栏对话界面;activeView=settings:设置整页覆盖。
// 壳只做机制:面板布局(PanelGroup)、标题栏 chrome、快捷键、设置框架。
// 功能是插件:左栏分组(sidebar 槽)、右面板页签(sidePanel 槽)、设置子页(settings 槽)。
//
// 快捷键:⌘B 左栏、⌘J 右面板、⌘N 新会话、⌘, 设置(macOS 经典,Ctrl 等价于非 Mac)。
import { createRoot } from "react-dom/client";
import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Panel, PanelGroup, PanelResizeHandle, getPanelGroupElement, type ImperativePanelHandle } from "react-resizable-panels";
import { ThemeProvider } from "./theme-context";
import { initI18n, subscribeLocaleChange } from "./i18n-init";
import { Titlebar } from "./components/titlebar";
import { Sidebar } from "./components/sidebar";
import { RightPanelContent, SidePanelStrip } from "./components/right-panel";
import { MainViewHost } from "./components/main-view-host";
import { SettingsPage } from "./components/settings-page";
import { useUiStore } from "./ui-store";
import { initSessionStore, useSessionStore } from "@pi-desktop/react";
// 触发内置插件 renderer 自注册(放在 render 后,不阻塞主渲染;
// 静态 import 会阻塞——如果插件 renderer 执行抛错,整个模块链中断导致白屏)
let pluginsLoaded = false;
function ensurePlugins(): void {
  if (pluginsLoaded) return;
  pluginsLoaded = true;
  // 注册完成后 bump pluginsNonce:槽壳订阅它重渲染,否则组件查找发生在注册前会永久"组件未注册"
  import("./plugins-host")
    .then(() => useUiStore.getState().bumpPlugins())
    .catch((err) => console.error("[plugins-host] 加载失败:", err));
}

// 左栏宽度约束(px,同 prefs sidebarWidth 的 180~500 契约;Panel 用百分比,按窗口宽换算)
const SIDEBAR_MIN_PX = 180;
const SIDEBAR_MAX_PX = 500;
const SIDEBAR_DEFAULT_PX = 260;

function ChatView(): React.ReactNode {
  const leftPanelOpen = useUiStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);
  const layoutRef = useRef<number[]>([]);
  const [leftHandleDragging, setLeftHandleDragging] = useState(false);
  const [rightHandleDragging, setRightHandleDragging] = useState(false);
  // 开关动画:只在点开关时挂 transition(拖拽时不挂,保持 1:1 跟手)
  const [animating, setAnimating] = useState(false);

  // 启动从 prefs 读左栏宽度(px→百分比 imperative resize;defaultSize 只是首帧兜底)
  useEffect(() => {
    void window.pi.prefs.get<number>("sidebarWidth").then((w) => {
      if (w && w >= SIDEBAR_MIN_PX && w <= SIDEBAR_MAX_PX) {
        const pgEl = getPanelGroupElement("chat-pg");
        const pgWidth = pgEl?.clientWidth ?? window.innerWidth;
        leftPanelRef.current?.resize((w / pgWidth) * 100);
      }
    });
  }, []);

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
    if (leftPanelOpen) p.expand(); else p.collapse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftPanelOpen]);
  useEffect(() => {
    const p = rightPanelRef.current;
    if (!p) return;
    animateToggle();
    if (rightPanelOpen) p.expand(); else p.collapse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightPanelOpen]);

  // 左栏拖拽结束把百分比折算回 px 落 prefs(供 settings 页/下次启动用)
  const onLeftHandleDragging = (dragging: boolean): void => {
    setLeftHandleDragging(dragging);
    if (!dragging && layoutRef.current.length > 0) {
      const pgEl = getPanelGroupElement("chat-pg");
      const pgWidth = pgEl?.clientWidth ?? window.innerWidth;
      const px = Math.round((layoutRef.current[0] / 100) * pgWidth);
      void window.pi.prefs.set("sidebarWidth", Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, px)));
    }
  };

  return (
    <div className="h-full flex bg-[var(--color-bg)] text-[var(--color-fg)] font-[var(--font-family-sans)]">
      <PanelGroup id="chat-pg" direction="horizontal" className="h-full flex-1 min-w-0" onLayout={(sizes) => { layoutRef.current = sizes; }}>
        <Panel
          ref={leftPanelRef}
          collapsible
          collapsedSize={0}
          defaultSize={(SIDEBAR_DEFAULT_PX / window.innerWidth) * 100}
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
          minSize={18}
          maxSize={45}
          className={animating ? "min-w-0 panel-collapse-anim" : "min-w-0"}
        >
          <RightPanelContent />
        </Panel>
      </PanelGroup>
      <SidePanelStrip />
    </div>
  );
}

function App(): React.ReactNode {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);

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
      <div className="flex-1 min-h-0">
        <AnimatePresence mode="sync">
          {activeView === "settings" ? (
            <motion.div key="settings" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} style={{ height: "100%" }}>
              <SettingsPage />
            </motion.div>
          ) : (
            <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} style={{ height: "100%" }}>
              <ChatView />
            </motion.div>
          )}
        </AnimatePresence>
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
  // 先从 electron-store hydrate 偏好 + 初始化 i18n,再挂载(避免主题/语言闪烁)
  // 加超时兜底:5s 不回也 render(不卡白屏)
  // hydrate 偏好后:若 lastCwd 有值,同步 main 进程 context(hydrateFromPrefs 只设 UI store,
  // main 的 SessionStore.activeCwd 需经 IPC setContext 同步;否则首条 prompt 报"未选择工作目录")
  const hydrateP = useUiStore.getState().hydrateFromPrefs().then(() => {
    const { currentCwd } = useUiStore.getState();
    if (currentCwd) void useSessionStore.getState().startNewChat(currentCwd);
  });
  const timeoutP = new Promise<void>((r) => setTimeout(r, 5000));
  Promise.race([Promise.all([hydrateP, initI18n()]), timeoutP])
    .catch(() => {})
    .finally(() => {
      try {
        initSessionStore(); // 会话投影通道(main→renderer)先于首帧挂上
        subscribeLocaleChange(); // currentLocale 变 → i18next.changeLanguage + document.lang(挂一次)
        const root = createRoot(rootEl);
        root.render(
          <ThemeProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </ThemeProvider>,
        );
        ensurePlugins(); // render 后异步加载插件(不阻塞主渲染)
      } catch (err) {
        console.error("[index] render failed:", err);
        rootEl.innerHTML = '<div style="padding:32px;color:red">render failed: ' + String(err) + '</div>';
      }
    });
}
