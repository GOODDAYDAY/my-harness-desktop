// 左侧栏风格 tab:左栏风格预设选择。
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  SIDEBAR_STYLE_PRESETS,
} from "@pi-desktop/react";
import { SidebarStylePreviewCard } from "../sidebar-style-preview";

export function SidebarTab(): React.ReactNode {
  const { t } = useTranslation();
  const { sidebarStyle, setSidebarStyle } = useUiStore();

  return (
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
  );
}
