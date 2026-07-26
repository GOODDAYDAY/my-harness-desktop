// 左侧栏 —— session-manager 插件的临时静态骨架 + 左下角设置齿轮。
//
// 依据 docs/plugins/11(session-manager):真正的会话树来自 pi 的 get_tree,
// 走 sidePanel 槽。这里是占位骨架,内容硬编码,等加载器落地后替换。
import { Settings } from "lucide-react";
import { useUiStore } from "../ui-store";

const SESSIONS = ["当前会话 · 架构梳理", "主题系统设计", "RPC 对接调研", "文档体系盲审"];

export function Sidebar(): React.ReactNode {
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  return (
    <div
      style={{
        width: "240px",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--color-border)",
        background: "var(--color-bg)",
      }}
    >
      <div style={{ padding: "var(--spacing-md) var(--spacing-lg)", fontWeight: 600, borderBottom: "1px solid var(--color-border)" }}>
        会话
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-sm) 0" }}>
        {SESSIONS.map((s, i) => (
          <div
            key={i}
            style={{
              padding: "var(--spacing-sm) var(--spacing-lg)",
              cursor: "pointer",
              background: i === 0 ? "var(--color-surface)" : "transparent",
              color: i === 0 ? "var(--color-fg)" : "var(--color-muted)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            {s}
          </div>
        ))}
      </div>
      {/* 左下角设置齿轮 */}
      <button
        onClick={() => setSettingsOpen(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-sm)",
          padding: "var(--spacing-md) var(--spacing-lg)",
          border: "none",
          borderTop: "1px solid var(--color-border)",
          background: "transparent",
          color: "var(--color-fg)",
          cursor: "pointer",
          fontFamily: "var(--font-family-sans)",
          fontSize: "var(--font-size-sm)",
        }}
      >
        <Settings size={16} />
        设置
      </button>
    </div>
  );
}
