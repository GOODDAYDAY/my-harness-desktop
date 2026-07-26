// renderer React 入口 —— 按主视图状态切换对话页 / 设置整页。
//
// mainView=chat:三栏对话界面(侧栏+消息流+输入框+右栏占位),左下角齿轮点开设置
// mainView=settings:设置整页覆盖(左插件列表 + 右配置页 + 返回按钮)
//
// 主题/字号从 useUiStore 读,ThemeProvider 动态注入,设置页实时切换。
// 当前是 shell/renderer 静态骨架,对话内容占位、未接 pi:
// - 会话列表 → session-manager 插件(docs/11)
// - 消息流 → timeline 插件(docs/08),event 流 + get_entries
// - 输入框 → commands 插件(docs/12),prompt 唯一发送出口
// - 设置页 → management 槽插件(docs/07),这里临时实现
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./theme-context";
import { Sidebar } from "./components/sidebar";
import { MessageList, Composer } from "./components/message-list";
import { SettingsPage } from "./components/settings-page";
import { useUiStore } from "./ui-store";

function ChatView(): React.ReactNode {
  return (
    <div style={{ display: "flex", height: "100%", background: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-family-sans)" }}>
      <Sidebar />
      {/* 中间:消息流 + 输入框一体,共用一列 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <MessageList />
        <Composer />
      </div>
      {/* 右侧栏:占位,后续放内容 */}
      <div style={{ width: "240px", flexShrink: 0, borderLeft: "1px solid var(--color-border)" }} />
    </div>
  );
}

function App(): React.ReactNode {
  const mainView = useUiStore((s) => s.mainView);
  return mainView === "settings" ? <SettingsPage /> : <ChatView />;
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}
