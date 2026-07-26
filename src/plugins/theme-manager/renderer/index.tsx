// theme-manager 插件 renderer —— 主题编排设置页 + 字体设置。
//
// theme-manager 贡献 settings 槽一项(component=ThemeSettings):
// - 主题列表从加载器注册表读(useTheme().themeOptions,来自各 theme-* 插件贡献)
// - 主题/字体偏好是桌面偏好 → ui-store(经 electron-store 持久化,06 §7)
// - theme-manager 自己的偏好(如 showFontPreview)是插件配置 → pi.config
//   (落 ~/.pi/desktop/plugins-data/theme-manager/config.json,DESIGN §3.2.4)
//
// 示范两套配置并存:桌面偏好(electron-store,全局)vs 插件配置(plugins-data,隔离)。
// 纯 renderer 插件(无 main,零 worker 成本,06 §8.2.2)。
//
// ⚠ 已知架构缺口(盲审 H1/F1,演进待修):
// 1. theme-manager renderer 直连 shell 内层(@/shell/renderer/ui-store 等),应经
//    @pi-desktop/react 受控 API——当前该包不存在,暂用 @ alias。
// 2. theme-manager 经 window.pi.config 直写插件配置,但 DESIGN §3.2.5 钉死
//    RendererPluginContext 不含 config——真应走 worker 中转(postToWorker→worker
//    context.config.set)。本次无 worker,用 pi.config 是阶段性简化,worker 落地后改。
// 后续建 @pi-desktop/react 包 + worker 侧 PluginContext 注入后,这两点一并修。
import { useEffect, useState } from "react";
import { useUiStore } from "@/shell/renderer/ui-store";
import { useTheme, MONO_CHOICES, SANS_TONES } from "@/shell/renderer/theme-context";
import { registerSettingsComponent } from "@/shell/renderer/settings-components";

// 注册本插件的配置页组件(加载本模块即触发,模拟加载器按 component 名解析)
registerSettingsComponent("ThemeSettings", ThemeSettings);

/** theme-manager 自己的配置 schema(示范"插件有自己的设置")。
 *  存 ~/.pi/desktop/plugins-data/theme-manager/config.json。 */
interface ThemeManagerConfig {
  /** 是否显示字体预览(本插件自己的偏好,非桌面偏好) */
  showFontPreview?: boolean;
}
const DEFAULT_CONFIG: ThemeManagerConfig = { showFontPreview: true };

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
  const { themeOptions } = useTheme();

  // theme-manager 自己的配置(经 pi.config 读 ~/.pi/desktop/plugins-data/theme-manager/config.json)
  const [showFontPreview, setShowFontPreview] = useState<boolean>(DEFAULT_CONFIG.showFontPreview!);
  useEffect(() => {
    void window.pi.config
      .get<boolean>("theme-manager", "showFontPreview")
      .then((v) => setShowFontPreview(v ?? DEFAULT_CONFIG.showFontPreview!));
  }, []);
  const toggleFontPreview = async (on: boolean): Promise<void> => {
    // 先写盘成功再 setState(盲审 F5:写盘失败回滚,避免 UI 显示已开但磁盘未落)
    try {
      await window.pi.config.set("theme-manager", "showFontPreview", on);
      setShowFontPreview(on);
    } catch (err) {
      console.error("[theme-manager] 写配置失败,已回滚", err);
    }
  };

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

      {/* 主题网格(主题列表来自加载器注册表) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--spacing-sm)" }}>
        {themeOptions.map((t) => {
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
          字体走系统栈,零打包。主题/字号/字体偏好跨重启保持。
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

      {/* theme-manager 自己的配置(示范:插件有自己的设置,落 plugins-data) */}
      <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "var(--spacing-lg)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>本插件设置</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          theme-manager 自己的偏好,存 ~/.pi/desktop/plugins-data/theme-manager/config.json(与桌面偏好分开)。
        </p>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={showFontPreview}
          onChange={(e) => void toggleFontPreview(e.target.checked)}
        />
        <span style={{ fontSize: "var(--font-size-sm)" }}>显示字体预览(本插件 config 示范)</span>
      </label>

      <div style={{ marginTop: "auto", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        当前主题:{currentThemeId}
      </div>
    </div>
  );
}
