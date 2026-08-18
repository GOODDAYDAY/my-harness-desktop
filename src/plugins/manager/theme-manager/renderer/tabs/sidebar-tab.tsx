// 左侧栏风格 tab:左栏风格预设选择。
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  SIDEBAR_STYLE_PRESETS,
  AREA_FONT_SCALE_MIN,
  AREA_FONT_SCALE_MAX,
} from "@my-harness-desktop/react";
import { SidebarStylePreviewCard } from "../sidebar-style-preview";

export function SidebarTab(): React.ReactNode {
  const { t } = useTranslation();
  const { sidebarStyle, setSidebarStyle, sidebarFontScale, setSidebarFontScale, setFontPreviewDragging } = useUiStore();

  return (
    <>
      <SettingsSection title={t("settings.sidebarFontScale")} description={t("settings.sidebarFontScaleDesc")}>
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            {t("settings.sidebarFontScale")} · {sidebarFontScale.toFixed(2)}
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={AREA_FONT_SCALE_MIN} max={AREA_FONT_SCALE_MAX} step={0.05} value={sidebarFontScale}
              onChange={(e) => setSidebarFontScale(Number(e.target.value))}
              onPointerDown={() => setFontPreviewDragging(true)}
              onPointerUp={() => setFontPreviewDragging(false)}
              style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>{t("settings.fontSmall")}</span><span>{t("settings.fontLarge")}</span>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.sidebarStyle")} description={t("settings.sidebarStyleDesc")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--spacing-md)" }}>
          {SIDEBAR_STYLE_PRESETS.map((preset) => (
            <SidebarStylePreviewCard
              key={preset.id}
              preset={preset}
              active={sidebarStyle === preset.id}
              onSelect={() => setSidebarStyle(preset.id)}
            />
          ))}
        </div>
      </SettingsSection>
    </>
  );
}
