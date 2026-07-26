// theme-manager 插件 renderer —— 主题编排设置页。
//
// theme-manager 贡献 settings 槽一项(component=ThemeSettings),
// 读 themes 槽所有主题(THEME_OPTIONS,来自 theme/theme-new-york/theme-silent/theme-stone
// 各插件贡献)渲染主题选择;加字体设置(字号/等宽/正文调性)。
//
// 这是"主题编排"插件——管理主题与字体偏好,本身不是主题。
// 纯 renderer 插件(无 main,零 worker 成本,见 06 §8.2.2)。
// 主题/字体选择写回 ui-store,ThemeProvider 实时重注入 CSS 变量。
import { useUiStore } from "../../../shell/renderer/ui-store";
import { THEME_OPTIONS, MONO_CHOICES, SANS_TONES } from "../../../shell/renderer/theme-context";

export function ThemeSettings(): React.ReactNode {
  const {
    currentThemeId,
    fontScale,
    fontMonoChoice,
    fontSansTone,
    setCurrentThemeId,
    setFontScale,
    setFontMonoChoice,
    setFontSansTone,
  } = useUiStore();

  return (
    <div
      style={{
        height: "100%",
        padding: "var(--spacing-xl)",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-xl)",
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>主题</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          选择主题,实时生效。每个主题来自独立的主题插件。
        </p>
      </div>

      {/* 主题网格 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--spacing-sm)" }}>
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

      <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "var(--spacing-lg)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>字体</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          字体走系统栈,零打包。等宽用于代码,正文调性切换无衬线/衬线/等宽。
        </p>
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

      {/* 等宽字体选择 */}
      <div>
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
          等宽字体(代码)
        </div>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
          {MONO_CHOICES.map((c) => {
            const selected = fontMonoChoice === c.id;
            return (
              <button
                key={c.id}
                onClick={() => setFontMonoChoice(c.id as typeof fontMonoChoice)}
                style={{
                  padding: "var(--spacing-xs) var(--spacing-md)",
                  border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
                  borderRadius: "var(--radius-sm)",
                  background: selected ? "var(--color-surface)" : "transparent",
                  color: "var(--color-fg)",
                  cursor: "pointer",
                  fontFamily: "var(--font-family-mono)",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 正文调性切换 */}
      <div>
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
          正文调性
        </div>
        <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
          {SANS_TONES.map((t) => {
            const selected = fontSansTone === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setFontSansTone(t.id as typeof fontSansTone)}
                style={{
                  padding: "var(--spacing-xs) var(--spacing-md)",
                  border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
                  borderRadius: "var(--radius-sm)",
                  background: selected ? "var(--color-surface)" : "transparent",
                  color: "var(--color-fg)",
                  cursor: "pointer",
                  fontFamily: t.id === "mono" ? "var(--font-family-mono)" : t.id === "serif" ? "Georgia, serif" : "var(--font-family-sans)",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: "auto", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        当前主题:{currentThemeId}
      </div>
    </div>
  );
}
