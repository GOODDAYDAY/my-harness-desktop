// renderer React 入口 —— 按主视图状态切换对话页 / 设置整页。
//
// mainView=chat:三栏对话界面(侧栏+消息流+输入框+右栏占位),左下角齿轮点开设置
// mainView=settings:设置整页覆盖(左插件列表 + 右配置页 + 返回按钮)
//
// 主题/字体从 useUiStore 读(启动从 electron-store hydrate,ThemeProvider 动态注入)。
// 当前是 shell/renderer 静态骨架,对话内容占位、未接 pi:
// - 会话列表 → session-manager 插件(docs/11)
// - 消息流 → timeline 插件(docs/08),event 流 + get_entries
// - 输入框 → commands 插件(docs/12),prompt 唯一发送出口
// - 设置页 → management 槽插件(docs/07),theme-manager 贡献 settings 槽一项
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion } from "framer-motion";
import { ThemeProvider } from "./theme-context";
import { Sidebar } from "./components/sidebar";
import { MessageList, Composer } from "./components/message-list";
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

function ChatView(): React.ReactNode {
  return (
    <div style={{ display: "flex", height: "100%", background: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-family-sans)" }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <MessageList />
        <Composer />
      </div>
      <div style={{ width: "240px", flexShrink: 0, borderLeft: "1px solid var(--color-border)" }} />
    </div>
  );
}

function App(): React.ReactNode {
  const mainView = useUiStore((s) => s.mainView);
  // 设置页从右滑入 + 淡入,返回右滑出 + 淡出(丝滑过渡,framer-motion)
  return (
    <AnimatePresence mode="wait">
      {mainView === "settings" ? (
        <motion.div
          key="settings"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          style={{ height: "100%" }}
        >
          <SettingsPage />
        </motion.div>
      ) : (
        <motion.div
          key="chat"
          initial={{ x: -40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -40, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          style={{ height: "100%" }}
        >
          <ChatView />
        </motion.div>
      )}
    </AnimatePresence>
  );
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
            <App />
          </ThemeProvider>,
        );
        ensurePlugins(); // render 后异步加载插件(不阻塞主渲染)
      } catch (err) {
        console.error("[index] render failed:", err);
        rootEl.innerHTML = '<div style="padding:32px;color:red">渲染失败: ' + String(err) + '</div>';
      }
    });
}
