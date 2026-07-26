// renderer React 入口
// 当前:套 ThemeProvider + 放一组 Button 验证主题 token → CSS 变量 → 组件链路。
// currentThemeId 暂硬编码,后续接 electron-store 偏好(见计划范围边界)。
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./theme-context";
import { Button } from "./ui/button";

// 改这个值验证六个主题:new-york-dark / new-york-light
//   / silent-dark / silent-light / stone-dark / stone-light
const CURRENT_THEME_ID = "new-york-dark";

function App(): React.ReactNode {
  return (
    <div style={{ padding: "var(--spacing-xl)", display: "flex", flexDirection: "column", gap: "var(--spacing-md)", alignItems: "flex-start" }}>
      <h1 style={{ fontSize: "var(--font-size-lg)", margin: 0 }}>pi-desktop · 主题验证</h1>
      <p style={{ color: "var(--color-muted)", margin: 0 }}>当前主题:{CURRENT_THEME_ID}</p>
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        <Button variant="primary">Primary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="outline">Outline</Button>
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ThemeProvider themeId={CURRENT_THEME_ID}>
      <App />
    </ThemeProvider>
  );
}
