// 右侧栏风格 tab:右面板风格预设选择。
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  SIDEPANEL_STYLE_PRESETS,
  SIDEPANEL_MIN_PX,
  SIDEPANEL_MAX_PX,
} from "@pi-desktop/react";
import { SidepanelStylePreviewCard } from "../sidepanel-style-preview";

export function SidepanelTab(): React.ReactNode {
  const { t } = useTranslation();
  const { sidepanelStyle, setSidepanelStyle, sidepanelWidth, setSidepanelWidth } = useUiStore();

  return (
    <>
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

      <SettingsSection title={t("settings.sidepanelWidth")} description={t("settings.sidepanelWidthDesc")}>
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            {t("settings.sidepanelWidth")} · {sidepanelWidth}px
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={SIDEPANEL_MIN_PX} max={SIDEPANEL_MAX_PX} step={10} value={sidepanelWidth}
              onChange={(e) => setSidepanelWidth(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>{SIDEPANEL_MIN_PX}px</span><span>{SIDEPANEL_MAX_PX}px</span>
            </div>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}
