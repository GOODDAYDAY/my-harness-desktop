import { useTranslation } from "react-i18next";
import { Select, SettingsSection, type SettingsComponentProps } from "@pi-desktop/react";


const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const LEVEL_I18N: Record<string, string> = {
  off: "shell.levelOff",
  minimal: "shell.levelMinimal",
  low: "shell.levelLow",
  medium: "shell.levelMedium",
  high: "shell.levelHigh",
  xhigh: "shell.levelXhigh",
};


export function GeneralConfigPage({ config, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const defaultThinkingLevel = String(config?.["defaultThinkingLevel"] ?? "high");
  const sidebarDefaultOpen = config?.["sidebarDefaultOpen"] === true;
  const showHiddenMessages = config?.["showHiddenMessages"] === true;
  const timelineCollapseDefault = (config?.["timelineCollapseDefault"] ?? true) === true;
  const isDev = import.meta.env.DEV;
  const debugMode = config?.["debugMode"] ?? isDev;

  const update = (key: string, value: unknown): void => {
    onChange({ ...config, [key]: value });
  };

  const checkboxStyle: React.CSSProperties = {
    width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--color-primary)",
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--spacing-lg)", alignContent: "start" }}>
      <SettingsSection title={t("settings.defaultThinkingLevel")} description={t("settings.defaultThinkingLevelDesc")}>
        <Select
          value={defaultThinkingLevel}
          onChange={(v) => update("defaultThinkingLevel", v)}
          style={{ width: "100%" }}
          ariaLabel={t("settings.defaultThinkingLevel")}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>{t(LEVEL_I18N[l])}</option>
          ))}
        </Select>
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
      <SettingsSection title={t("settings.showHiddenMessages")} description={t("settings.showHiddenMessagesDesc")}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showHiddenMessages}
            onChange={(e) => update("showHiddenMessages", e.target.checked)}
            style={checkboxStyle}
          />
          <span style={{ fontSize: "var(--font-size-sm)" }}>{showHiddenMessages ? t("common.on") : t("common.off")}</span>
        </label>
      </SettingsSection>
      <SettingsSection title={t("settings.timelineCollapseDefault")} description={t("settings.timelineCollapseDefaultDesc")}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={timelineCollapseDefault}
            onChange={(e) => update("timelineCollapseDefault", e.target.checked)}
            style={checkboxStyle}
          />
          <span style={{ fontSize: "var(--font-size-sm)" }}>{timelineCollapseDefault ? t("common.on") : t("common.off")}</span>
        </label>
      </SettingsSection>
      <SettingsSection title="Debug 模式" description="开启后在会话流右上角显示调试工具（复制当前渲染状态）。开发环境默认开启。">
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={debugMode as boolean}
            onChange={(e) => update("debugMode", e.target.checked)}
            style={checkboxStyle}
          />
          <span style={{ fontSize: "var(--font-size-sm)" }}>{debugMode ? t("common.on") : t("common.off")}</span>
        </label>
      </SettingsSection>
    </div>
  );
}
