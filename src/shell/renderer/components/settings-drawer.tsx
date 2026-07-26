// 设置抽屉 —— 主题选择 + 字号调节,点齿轮从右侧滑出。
//
// 这是 shell/renderer 的 UI 组件,不是插件(真正的 settings 槽插件走 management 槽,
// 见 docs/plugins/07)。此处为验证"可调"链路的最小实现:
// - 切主题 → useUiStore.setCurrentThemeId → ThemeProvider 重注入 CSS 变量(实时)
// - 调字号 → useUiStore.setFontScale → --font-size-* 倍率覆盖(实时)
import { X } from "lucide-react";
import { useUiStore } from "../ui-store";
import { THEME_OPTIONS } from "../theme-context";

export function SettingsDrawer(): React.ReactNode {
  const { currentThemeId, fontScale, settingsOpen, setCurrentThemeId, setFontScale, setSettingsOpen } =
    useUiStore();

  if (!settingsOpen) return null;

  return (
    <div
      style={{
        width: "280px",
        flexShrink: 0,
        borderLeft: "1px solid var(--color-border)",
        background: "var(--color-bg)",
        display: "flex",
        flexDirection: "column",
        padding: "var(--spacing-lg) var(--spacing-lg)",
        gap: "var(--spacing-lg)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 600 }}>设置</div>
        <button
          onClick={() => setSettingsOpen(false)}
          style={{ border: "none", background: "transparent", color: "var(--color-muted)", cursor: "pointer", padding: "var(--spacing-xs)" }}
        >
          <X size={16} />
        </button>
      </div>

      {/* 主题选择 */}
      <div>
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
          主题
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
          {THEME_OPTIONS.map((t) => (
            <button
              key={t.id}
              onClick={() => setCurrentThemeId(t.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--spacing-sm)",
                padding: "var(--spacing-sm) var(--spacing-md)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                background: currentThemeId === t.id ? "var(--color-surface)" : "transparent",
                color: "var(--color-fg)",
                cursor: "pointer",
                fontFamily: "var(--font-family-sans)",
                fontSize: "var(--font-size-sm)",
                textAlign: "left",
              }}
            >
              <span
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "50%",
                  border: currentThemeId === t.id ? "2px solid var(--color-primary)" : "1px solid var(--color-border)",
                  flexShrink: 0,
                }}
              />
              {t.name}
            </button>
          ))}
        </div>
      </div>

      {/* 字号调节 */}
      <div>
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
          字号倍率 · {fontScale.toFixed(2)}
        </div>
        <input
          type="range"
          min={0.75}
          max={1.5}
          step={0.05}
          value={fontScale}
          onChange={(e) => setFontScale(Number(e.target.value))}
          style={{ width: "100%" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
          <span>小</span>
          <span>大</span>
        </div>
      </div>

      <div style={{ marginTop: "auto", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        当前主题:{currentThemeId}
      </div>
    </div>
  );
}
