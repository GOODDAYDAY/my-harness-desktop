// 设置整页 —— 点齿轮整页覆盖主界面。
//
// 布局:左边插件列表 + 右边选中插件的配置页 + 顶部返回按钮。
// 第一步左边只列"主题"一个插件项,右边主题配置页(主题选择 + 字号)。
// 后续一项一项往左列表加(i18n/management/commands…),每个加一个配置页。
//
// 这对应 docs/plugins/07(management-ui)+ settings 槽的临时实现:
// 真正的设置走 management 槽,这里是 shell/renderer 的静态骨架。
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useUiStore } from "../ui-store";
import { THEME_OPTIONS } from "../theme-context";

/** 左边插件列表项(第一步只有主题一项)。 */
const PLUGIN_ITEMS = [
  { id: "theme", name: "主题", description: "主题与字号" },
] as const;

function ThemeConfigPage(): React.ReactNode {
  const { currentThemeId, fontScale, setCurrentThemeId, setFontScale } = useUiStore();
  return (
    <div style={{ padding: "var(--spacing-xl)", maxWidth: "640px", display: "flex", flexDirection: "column", gap: "var(--spacing-xl)" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>主题配置</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          选择主题与字号,实时生效。
        </p>
      </div>

      {/* 主题选择 */}
      <div>
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
          主题
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "var(--spacing-sm)" }}>
          {THEME_OPTIONS.map((t) => {
            const selected = currentThemeId === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setCurrentThemeId(t.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--spacing-sm)",
                  padding: "var(--spacing-sm) var(--spacing-md)",
                  border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
                  borderRadius: "var(--radius-md)",
                  background: selected ? "var(--color-surface)" : "transparent",
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
                    border: selected ? "2px solid var(--color-primary)" : "1px solid var(--color-border)",
                    flexShrink: 0,
                  }}
                />
                {t.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 字号倍率 */}
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

      <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        当前主题:{currentThemeId}
      </div>
    </div>
  );
}

export function SettingsPage(): React.ReactNode {
  const setMainView = useUiStore((s) => s.setMainView);
  const [activePlugin, setActivePlugin] = useState<string>("theme");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-family-sans)" }}>
      {/* 顶部:返回按钮 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-sm)",
          padding: "var(--spacing-md) var(--spacing-lg)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <button
          onClick={() => setMainView("chat")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-xs)",
            border: "none",
            background: "transparent",
            color: "var(--color-muted)",
            cursor: "pointer",
            fontFamily: "var(--font-family-sans)",
            fontSize: "var(--font-size-sm)",
            padding: "var(--spacing-xs) var(--spacing-sm)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <ArrowLeft size={16} />
          返回对话
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 左边:插件列表 */}
        <div
          style={{
            width: "220px",
            flexShrink: 0,
            borderRight: "1px solid var(--color-border)",
            padding: "var(--spacing-sm) 0",
            overflowY: "auto",
          }}
        >
          {PLUGIN_ITEMS.map((p) => {
            const active = activePlugin === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setActivePlugin(p.id)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "var(--spacing-sm) var(--spacing-lg)",
                  border: "none",
                  borderLeft: active ? "2px solid var(--color-primary)" : "2px solid transparent",
                  background: active ? "var(--color-surface)" : "transparent",
                  color: active ? "var(--color-fg)" : "var(--color-muted)",
                  cursor: "pointer",
                  fontFamily: "var(--font-family-sans)",
                  fontSize: "var(--font-size-sm)",
                  textAlign: "left",
                }}
              >
                <div style={{ fontWeight: 500 }}>{p.name}</div>
                <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginTop: "2px" }}>
                  {p.description}
                </div>
              </button>
            );
          })}
        </div>

        {/* 右边:选中插件的配置页 */}
        <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
          {activePlugin === "theme" ? <ThemeConfigPage /> : <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)" }}>暂未配置</div>}
        </div>
      </div>
    </div>
  );
}
