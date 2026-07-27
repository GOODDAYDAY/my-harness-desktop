// renderer React 入口 —— 按主视图状态切换对话页 / 设置整页。
//
// mainView=chat:两栏对话界面(侧栏 + 主区中轴居中的消息流+输入框),齿轮点开设置
// mainView=settings:设置整页覆盖(左插件列表 + 右配置页 + 返回按钮)
//
// 主题/字体从 useUiStore 读(启动从 electron-store hydrate,ThemeProvider 动态注入)。
// 当前是 shell/renderer 静态骨架,对话内容占位、未接 pi:
// - 会话列表 → session-manager 插件(docs/11)
// - 消息流 → timeline 插件(docs/08),event 流 + get_entries
// - 输入框 → commands 插件(docs/12),prompt 唯一发送出口
// - 设置页 → management 槽插件(docs/07),theme-manager 贡献 settings 槽一项
import { createRoot } from "react-dom/client";
import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion"; // 暂保留(settings-page 内部用)
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { ThemeProvider } from "./theme-context";
import { Sidebar } from "./components/sidebar";
import { MessageList } from "./components/message-list";
import { SettingsPage } from "./components/settings-page";
import { useUiStore } from "./ui-store";
// 触发内置插件 renderer 自注册(放在 render 后,不阻塞主渲染;
// 静态 import 会阻塞——如果插件 renderer 执行抛错,整个模块链中断导致白屏)
// 改成动态 import,即使插件加载失败也不影响主界面
let pluginsLoaded = false;
function ensurePlugins(): void {
  if (pluginsLoaded) return;
  pluginsLoaded = true;
  import("./plugins-host").catch((err) => console.error("[plugins-host] 加载失败:", err));
}

// 侧栏宽度约束(px,同 prefs sidebarWidth 的 180~500 契约;Panel 用百分比,按窗口宽换算)
const SIDEBAR_MIN_PX = 180;
const SIDEBAR_MAX_PX = 500;
const SIDEBAR_DEFAULT_PX = 240;

function ChatView(): React.ReactNode {
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const layoutRef = useRef<number[]>([]);
  const [handleDragging, setHandleDragging] = useState(false);

  // 启动从 prefs 读侧栏宽度(px→百分比 imperative resize;defaultSize 只是首帧兜底)
  useEffect(() => {
    void window.pi.prefs.get<number>("sidebarWidth").then((w) => {
      if (w && w >= SIDEBAR_MIN_PX && w <= SIDEBAR_MAX_PX) {
        sidebarPanelRef.current?.resize((w / window.innerWidth) * 100);
      }
    });
  }, []);

  // 拖拽结束(onDragging false)把当前百分比折算回 px 落 prefs(供 settings 页/下次启动用)
  const onHandleDragging = (dragging: boolean): void => {
    setHandleDragging(dragging);
    if (!dragging && layoutRef.current.length > 0) {
      const px = Math.round((layoutRef.current[0] / 100) * window.innerWidth);
      void window.pi.prefs.set("sidebarWidth", Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, px)));
    }
  };

  return (
    <div className="h-full bg-[var(--color-bg)] text-[var(--color-fg)] font-[var(--font-family-sans)]">
      <PanelGroup direction="horizontal" className="h-full" onLayout={(sizes) => { layoutRef.current = sizes; }}>
        <Panel
          ref={sidebarPanelRef}
          defaultSize={(SIDEBAR_DEFAULT_PX / window.innerWidth) * 100}
          minSize={(SIDEBAR_MIN_PX / window.innerWidth) * 100}
          maxSize={(SIDEBAR_MAX_PX / window.innerWidth) * 100}
          className="min-w-0"
        >
          <Sidebar />
        </Panel>
        <PanelResizeHandle
          onDragging={onHandleDragging}
          style={{
            width: "4px",
            cursor: "col-resize",
            background: handleDragging ? "var(--color-primary)" : "transparent",
            transition: "background 0.15s",
          }}
        />
        {/* 主区:内部 max-w-6xl mx-auto 中轴居中(呼应 OpenWebUI)。
            Composer 已在 MessageList 内部渲染(软容器贴消息流底部),此处不重复放。 */}
        <Panel className="min-w-0">
          <div className="h-full flex flex-col max-w-6xl w-full mx-auto px-4 lg:px-6">
            <MessageList />
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function App(): React.ReactNode {
  const mainView = useUiStore((s) => s.mainView);
  // 转场动画:不用 mode="wait"(chat exit 后 settings 不 mount),用默认 sync
  // off 问题已修(ipcRenderer.on 返回 IpcRenderer 不是 cleanup 函数,改用 removeListener)
  return (
    <AnimatePresence mode="sync">
      {mainView === "settings" ? (
        <motion.div key="settings" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} style={{ height: "100%" }}>
          <SettingsPage />
        </motion.div>
      ) : (
        <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} style={{ height: "100%" }}>
          <ChatView />
        </motion.div>
      )}
    </AnimatePresence>
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
  // 先从 electron-store hydrate 偏好,再挂载(避免主题闪烁)
  // 加超时兜底:hydrateFromPrefs 5s 不回也 render(不卡白屏)
  const hydrateP = useUiStore.getState().hydrateFromPrefs();
  const timeoutP = new Promise<void>((r) => setTimeout(r, 5000));
  Promise.race([hydrateP, timeoutP])
    .catch(() => {})
    .finally(() => {
      try {
        const root = createRoot(rootEl);
        root.render(
          <ThemeProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </ThemeProvider>,
        );
        ensurePlugins(); // render 后异步加载插件(不阻塞主渲染)
        // Pi 默认打开:不在 index.tsx 调 rpc.start(会和 MessageList 的 useEffect 竞争
        // 导致二次 start)。rpc.start 由 MessageList 的 useEffect 管(切目录时 sidebar 调)。
      } catch (err) {
        console.error("[index] render failed:", err);
        rootEl.innerHTML = '<div style="padding:32px;color:red">渲染失败: ' + String(err) + '</div>';
      }
    });
}
