// 右侧栏风格 tab:右面板风格预设选择。
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  SIDEPANEL_STYLE_PRESETS,
  AREA_FONT_SCALE_MIN,
  AREA_FONT_SCALE_MAX,
} from "@pi-desktop/react";
import { SidepanelStylePreviewCard } from "../sidepanel-style-preview";

export function SidepanelTab(): React.ReactNode {
  const { t } = useTranslation();
  const { sidepanelStyle, setSidepanelStyle, sidepanelFontScale, setSidepanelFontScale } = useUiStore();

  return (
    <>
      <SettingsSection title={t("settings.sidepanelFontScale")} description={t("settings.sidepanelFontScaleDesc")}>
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            {t("settings.sidepanelFontScale")} · {sidepanelFontScale.toFixed(2)}
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={AREA_FONT_SCALE_MIN} max={AREA_FONT_SCALE_MAX} step={0.05} value={sidepanelFontScale}
              onChange={(e) => setSidepanelFontScale(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>{t("settings.fontSmall")}</span><span>{t("settings.fontLarge")}</span>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.sidepanelStyle")} description={t("settings.sidepanelStyleDesc")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--spacing-md)" }}>
          {SIDEPANEL_STYLE_PRESETS.map((preset) => (
            <SidepanelStylePreviewCard
              key={preset.id}
              preset={preset}
              active={sidepanelStyle === preset.id}
              onSelect={() => setSidepanelStyle(preset.id)}
            />
          ))}
        </div>
      </SettingsSection>
    </>
  );
}
