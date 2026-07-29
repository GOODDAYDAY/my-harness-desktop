import { useTranslation } from "react-i18next";
import { registerSettingsComponent, SettingsSection, type SettingsComponentProps } from "@pi-desktop/react";

registerSettingsComponent("GeneralConfigPage", GeneralConfigPage);

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const LEVEL_I18N: Record<string, string> = {
  off: "shell.levelOff",
  minimal: "shell.levelMinimal",
  low: "shell.levelLow",
  medium: "shell.levelMedium",
  high: "shell.levelHigh",
  xhigh: "shell.levelXhigh",
};

const inputStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  fontSize: "var(--font-size-sm)",
  width: "100%",
  boxSizing: "border-box",
};

function GeneralConfigPage({ config, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const defaultThinkingLevel = String(config?.["defaultThinkingLevel"] ?? "high");
  const sidebarDefaultOpen = config?.["sidebarDefaultOpen"] === true;

  const update = (key: string, value: unknown): void => {
    onChange({ ...config, [key]: value });
  };

  const checkboxStyle: React.CSSProperties = {
    width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--color-primary)",
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <SettingsSection title={t("settings.defaultThinkingLevel")} description={t("settings.defaultThinkingLevelDesc")}>
        <select
          value={defaultThinkingLevel}
          onChange={(e) => update("defaultThinkingLevel", e.target.value)}
          style={inputStyle}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>{t(LEVEL_I18N[l])}</option>
          ))}
        </select>
      </SettingsSection>
      <SettingsSection title={t("settings.sidebarDefaultOpen")} description={t("settings.sidebarDefaultOpenDesc")}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={sidebarDefaultOpen}
            onChange={(e) => update("sidebarDefaultOpen", e.target.checked)}
            style={checkboxStyle}
          />
          <span style={{ fontSize: "var(--font-size-sm)" }}>{sidebarDefaultOpen ? t("common.on") : t("common.off")}</span>
        </label>
      </SettingsSection>
    </div>
  );
}
