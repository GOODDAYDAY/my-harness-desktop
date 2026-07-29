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
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  usePiApi,
  registerSettingsComponent,
  SettingsSection,
  SIDEBAR_STYLES,
  SIDEPANEL_STYLES,
  type SettingsComponentProps,
  MONO_CHOICES,
  SANS_TONES,
} from "@pi-desktop/react";
import { ThemePreviewCard } from "./theme-preview";
import { SidebarStylePreviewCard } from "./sidebar-style-preview";
import { SidepanelStylePreviewCard } from "./sidepanel-style-preview";

registerSettingsComponent("ThemeSettings", ThemeSettings);

interface ThemeManagerConfig {
  showFontPreview?: boolean;
}
const DEFAULT_CONFIG: ThemeManagerConfig = { showFontPreview: true };

export function ThemeSettings({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const {
    currentThemeId,
    fontScale,
    fontMonoChoice,
    fontSansTone,
    sidebarStyle,
    setCurrentThemeId,
    setFontScale,
    setFontMonoChoice,
    setFontSansTone,
    setSidebarStyle,
    sidepanelStyle,
    setSidepanelStyle,
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
      <SettingsSection title={t("settings.font")} description={t("settings.fontDesc")}>
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            {t("settings.fontScale")} · {fontScale.toFixed(2)}
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={0.5} max={2} step={0.05} value={fontScale}
              onChange={(e) => setFontScale(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>{t("settings.fontSmall")}</span><span>{t("settings.fontLarge")}</span>
            </div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>{t("settings.monoFont")}</div>
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
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>{t("settings.sansTone")}</div>
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

      <SettingsSection title={t("settings.pluginOwn")} description={t("settings.pluginOwnDesc")}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
          <input type="checkbox" checked={showFontPreview} onChange={(e) => void toggleFontPreview(e.target.checked)} />
          <span style={{ fontSize: "var(--font-size-sm)" }}>{t("settings.showFontPreview")}</span>
        </label>
      </SettingsSection>

      <SettingsSection title={t("settings.theme")} description={t("settings.themeDesc")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "var(--spacing-md)" }}>
          {themeOptions.map((opt) => (
            <ThemePreviewCard
              key={opt.id}
              themeId={opt.id}
              label={opt.name.includes(".") ? t(opt.name, { defaultValue: opt.name }) : opt.name}
              active={currentThemeId === opt.id}
              onSelect={() => setCurrentThemeId(opt.id)}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.sidebarStyle")} description={t("settings.sidebarStyleDesc")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--spacing-md)" }}>
          {SIDEBAR_STYLES.map((preset) => (
            <SidebarStylePreviewCard
              key={preset.id}
              preset={preset}
              active={sidebarStyle === preset.id}
              onSelect={() => setSidebarStyle(preset.id)}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.sidepanelStyle")} description={t("settings.sidepanelStyleDesc")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--spacing-md)" }}>
          {SIDEPANEL_STYLES.map((preset) => (
            <SidepanelStylePreviewCard
              key={preset.id}
              preset={preset}
              active={sidepanelStyle === preset.id}
              onSelect={() => setSidepanelStyle(preset.id)}
            />
          ))}
        </div>
      </SettingsSection>

      <div style={{ marginTop: "auto", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        {t("settings.currentTheme")}:{currentThemeId}
      </div>
    </div>
  );
}
