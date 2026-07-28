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

  const update = (key: string, value: unknown): void => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <SettingsSection title={t("settings.general")} description={t("settings.generalDesc")}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
            <label style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}>{t("settings.defaultThinkingLevel")}</label>
            <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("settings.defaultThinkingLevelDesc")}</span>
            <select
              value={defaultThinkingLevel}
              onChange={(e) => update("defaultThinkingLevel", e.target.value)}
              style={inputStyle}
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>{t(LEVEL_I18N[l])}</option>
              ))}
            </select>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
