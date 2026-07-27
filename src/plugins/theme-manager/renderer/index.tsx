// theme-manager 插件 renderer —— 主题编排设置页 + 字体设置。
//
// 经 @pi-desktop/react 受控 API(守薄壳 H1:不直连 shell):
// - 主题列表 → usePiApi().themes.list()(加载器注册表)
// - 主题/字体偏好 → useUiStore(经 @pi-desktop/react,落 electron-store)
// - theme-manager 自己的偏好(showFontPreview)→ usePiApi().config(落 plugins-data)
//
// 示范两套配置并存:桌面偏好(electron-store,全局)vs 插件配置(plugins-data,隔离)。
// 纯 renderer 插件(无 main,零 worker 成本,06 §8.2.2)。
import { useEffect, useState } from "react";
import {
  useUiStore,
  usePiApi,
  registerSettingsComponent,
  SettingsSection,
  ListItem,
  type SettingsComponentProps,
  MONO_CHOICES,
  SANS_TONES,
} from "@pi-desktop/react";

registerSettingsComponent("ThemeSettings", ThemeSettings);

interface ThemeManagerConfig {
  showFontPreview?: boolean;
}
const DEFAULT_CONFIG: ThemeManagerConfig = { showFontPreview: true };

export function ThemeSettings({ refreshSignal }: SettingsComponentProps): React.ReactNode {
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
  const pi = usePiApi();
  const [themeOptions, setThemeOptions] = useState<{ id: string; name: string }[]>([]);
  const [showFontPreview, setShowFontPreview] = useState<boolean>(DEFAULT_CONFIG.showFontPreview!);

  // 启动拉主题列表 + 自己的 config
  useEffect(() => {
    void pi.themes.list().then(setThemeOptions);
    void pi.config
      .get<boolean>("theme-manager", "showFontPreview")
      .then((v) => setShowFontPreview(v ?? DEFAULT_CONFIG.showFontPreview!));
  }, [pi, refreshSignal]);

  const toggleFontPreview = async (on: boolean): Promise<void> => {
    try {
      await pi.config.set("theme-manager", "showFontPreview", on);
      setShowFontPreview(on);
    } catch (err) {
      console.error("[theme-manager] 写配置失败,已回滚", err);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "var(--spacing-xl)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-xl)",
      }}
    >
      <SettingsSection title="主题" description="选择主题,实时生效。每个主题来自独立的主题插件。">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--spacing-sm)" }}>
          {themeOptions.map((t) => (
            <ListItem key={t.id} active={currentThemeId === t.id} onClick={() => setCurrentThemeId(t.id)} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", border: currentThemeId === t.id ? "2px solid var(--color-primary)" : "1px solid var(--color-border)", flexShrink: 0 }} />
              {t.name}
            </ListItem>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="字体" description="字体走系统栈,零打包。主题/字号/字体偏好跨重启保持。">
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            字号倍率 · {fontScale.toFixed(2)}
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={0.5} max={2} step={0.05} value={fontScale}
              onChange={(e) => setFontScale(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>小</span><span>大</span>
            </div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>等宽字体(代码)</div>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
            {MONO_CHOICES.map((c) => {
              const selected = fontMonoChoice === c.id;
              return (
                <button key={c.id} onClick={() => setFontMonoChoice(c.id as typeof fontMonoChoice)}
                  style={{ padding: "var(--spacing-xs) var(--spacing-md)",
                    border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
                    borderRadius: "var(--radius-sm)",
                    background: selected ? "var(--color-surface)" : "transparent",
                    color: "var(--color-fg)", cursor: "pointer",
                    fontFamily: c.stack, fontSize: "var(--font-size-sm)" }}>
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>正文调性</div>
          <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
            {SANS_TONES.map((t) => {
              const selected = fontSansTone === t.id;
              return (
                <button key={t.id} onClick={() => setFontSansTone(t.id as typeof fontSansTone)}
                  style={{ padding: "var(--spacing-xs) var(--spacing-md)",
                    border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
                    borderRadius: "var(--radius-sm)",
                    background: selected ? "var(--color-surface)" : "transparent",
                    color: "var(--color-fg)", cursor: "pointer",
                    fontFamily: t.stack, fontSize: "var(--font-size-sm)" }}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="本插件设置" description="theme-manager 自己的偏好,存 ~/.pi-desktop/config/plugins-data/theme-manager/config.json(与桌面偏好分开)。">
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
          <input type="checkbox" checked={showFontPreview} onChange={(e) => void toggleFontPreview(e.target.checked)} />
          <span style={{ fontSize: "var(--font-size-sm)" }}>显示字体预览(本插件 config 示范)</span>
        </label>
      </SettingsSection>

      <div style={{ marginTop: "auto", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        当前主题:{currentThemeId}
      </div>
    </div>
  );
}
