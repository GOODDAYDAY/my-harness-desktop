// 左侧栏 —— 会话列表 + 设置按钮,用框架级 ListItem(圆角+hover)。
import { Settings } from "lucide-react";
import { useUiStore } from "../ui-store";
import { ListItem } from "@pi-desktop/react";

const SESSIONS = ["当前会话 · 架构梳理", "主题系统设计", "RPC 对接调研", "文档体系盲审"];

export function Sidebar(): React.ReactNode {
  const setMainView = useUiStore((s) => s.setMainView);
  return (
    <div style={{ width: "240px", flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
      <div style={{ padding: "var(--spacing-md) var(--spacing-lg)", fontWeight: 600, borderBottom: "1px solid var(--color-border)" }}>
        会话
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-sm)", display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        {SESSIONS.map((s, i) => (
          <ListItem key={i} active={i === 0}>
            {s}
          </ListItem>
        ))}
      </div>
      <div style={{ padding: "var(--spacing-sm)", borderTop: "1px solid var(--color-border)" }}>
        <ListItem onClick={() => setMainView("settings")} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
          <Settings size={16} />
          设置
        </ListItem>
      </div>
    </div>
  );
}
