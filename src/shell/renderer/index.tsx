// renderer React 入口 —— 三栏对话界面骨架。
//
// 布局:左侧栏(会话+齿轮)| 中间(消息流+输入框一体) | 右侧栏(占位/设置抽屉)
// 主题/字号从 useUiStore 读,ThemeProvider 动态注入,设置抽屉实时切换。
//
// 当前是 shell/renderer 的静态骨架,对话内容占位,未接 pi:
// - 会话列表 → session-manager 插件(docs/11)
// - 消息流 → timeline 插件(docs/08),event 流 + get_entries
// - 输入框 → commands 插件(docs/12),prompt 唯一发送出口
// - 设置抽屉 → settings 槽插件(docs/07)的临时实现
// 等加载器 + RPC 对接后,这些骨架替换为真实插件实现。
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./theme-context";
import { Sidebar } from "./components/sidebar";
import { MessageList, Composer } from "./components/message-list";
import { SettingsDrawer } from "./components/settings-drawer";
import { useUiStore } from "./ui-store";

function App(): React.ReactNode {
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        background: "var(--color-bg)",
        color: "var(--color-fg)",
        fontFamily: "var(--font-family-sans)",
      }}
    >
      <Sidebar />
      {/* 中间:消息流 + 输入框一体,共用一列 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <MessageList />
        <Composer />
      </div>
      {/* 右侧栏:默认占位(后续放内容),设置抽屉打开时作为右栏内容滑入 */}
      {settingsOpen ? (
        <SettingsDrawer />
      ) : (
        <div style={{ width: "240px", flexShrink: 0, borderLeft: "1px solid var(--color-border)" }}>
          {/* 右栏占位:后续放内容 */}
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}
