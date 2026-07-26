// 左侧栏 —— session-manager 插件的临时静态骨架 + 左下角设置齿轮。
//
// 依据 docs/plugins/11(session-manager):真正的会话树来自 pi 的 get_tree,
// 走 sidePanel 槽。这里是占位骨架,内容硬编码,等加载器落地后替换。
import { Settings } from "lucide-react";
import { useUiStore } from "../ui-store";

const SESSIONS = ["当前会话 · 架构梳理", "主题系统设计", "RPC 对接调研", "文档体系盲审"];

export function Sidebar(): React.ReactNode {
  const setMainView = useUiStore((s) => s.setMainView);
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
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-sm) var(--spacing-sm)", display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        {SESSIONS.map((s, i) => (
          <div
            key={i}
            style={{
              padding: "var(--spacing-sm) var(--spacing-md)",
              cursor: "pointer",
              background: i === 0 ? "var(--color-surface)" : "transparent",
              color: i === 0 ? "var(--color-fg)" : "var(--color-muted)",
              fontSize: "var(--font-size-sm)",
              borderRadius: "var(--radius-md)",
              border: "1px solid transparent",
              transition: "background 0.15s, border-color 0.15s",
            }}
            onMouseEnter={(e) => {
              if (i !== 0) {
                e.currentTarget.style.background = "var(--color-surface)";
                e.currentTarget.style.borderColor = "var(--color-border)";
              }
            }}
            onMouseLeave={(e) => {
              if (i !== 0) {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.borderColor = "transparent";
              }
            }}
          >
            {s}
          </div>
        ))}
      </div>
      {/* 左下角设置齿轮:点开设置整页 */}
      <div style={{ padding: "var(--spacing-sm)", borderTop: "1px solid var(--color-border)" }}>
        <button
          onClick={() => setMainView("settings")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-sm)",
            padding: "var(--spacing-sm) var(--spacing-md)",
            border: "1px solid transparent",
            borderRadius: "var(--radius-md)",
            background: "transparent",
            color: "var(--color-fg)",
            cursor: "pointer",
            fontFamily: "var(--font-family-sans)",
            fontSize: "var(--font-size-sm)",
            width: "100%",
            textAlign: "left",
            transition: "background 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-surface)"; e.currentTarget.style.borderColor = "var(--color-border)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
        >
          <Settings size={16} />
          设置
        </button>
      </div>
    </div>
  );
}
