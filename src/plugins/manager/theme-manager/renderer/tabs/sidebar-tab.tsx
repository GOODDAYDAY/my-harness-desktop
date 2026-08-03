// 左侧栏风格 tab:左栏风格预设选择。
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  SIDEBAR_STYLE_PRESETS,
  SIDEBAR_MIN_PX,
  SIDEBAR_MAX_PX,
} from "@pi-desktop/react";
import { SidebarStylePreviewCard } from "../sidebar-style-preview";

export function SidebarTab(): React.ReactNode {
  const { t } = useTranslation();
  const { sidebarStyle, setSidebarStyle, sidebarWidth, setSidebarWidth } = useUiStore();

  return (
    <>
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

      <SettingsSection title={t("settings.sidebarWidth")} description={t("settings.sidebarWidthDesc")}>
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            {t("settings.sidebarWidth")} · {sidebarWidth}px
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={SIDEBAR_MIN_PX} max={SIDEBAR_MAX_PX} step={10} value={sidebarWidth}
              onChange={(e) => setSidebarWidth(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>{SIDEBAR_MIN_PX}px</span><span>{SIDEBAR_MAX_PX}px</span>
            </div>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}
