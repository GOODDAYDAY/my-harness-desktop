// 右侧栏风格 tab:右面板风格预设选择。
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  SIDEPANEL_STYLE_PRESETS,
} from "@pi-desktop/react";
import { SidepanelStylePreviewCard } from "../sidepanel-style-preview";

export function SidepanelTab(): React.ReactNode {
  const { t } = useTranslation();
  const { sidepanelStyle, setSidepanelStyle } = useUiStore();

  return (
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
  );
}
