import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Select, SettingsSection, type SettingsComponentProps, usePluginContext, type AppInfo } from "@pi-desktop/react";


const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const LEVEL_I18N: Record<string, string> = {
  off: "shell.levelOff",
  minimal: "shell.levelMinimal",
  low: "shell.levelLow",
  medium: "shell.levelMedium",
  high: "shell.levelHigh",
  xhigh: "shell.levelXhigh",
};


const APPLY_TIMINGS = ["onSend", "immediate"] as const;

const APPLY_TIMING_I18N: Record<string, string> = {
  onSend: "settings.applyOnSend",
  immediate: "settings.applyImmediate",
};


function OptRow({ name, desc, first, children }: { name: string; desc?: string; first?: boolean; children: React.ReactNode }): React.ReactNode {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: "var(--spacing-sm)",
      padding: "var(--spacing-sm) 0",
      borderTop: first ? "none" : "1px solid var(--color-border)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--font-size-sm)" }}>{name}</div>
        {desc && <div style={{ marginTop: "2px", fontSize: "var(--font-size-xs)", color: "var(--color-muted)", lineHeight: 1.5 }}>{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export function GeneralConfigPage({ config, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  useEffect(() => { void ctx.appInfo.get().then(setAppInfo); }, [ctx]);
  const defaultThinkingLevel = String(config?.["defaultThinkingLevel"] ?? "high");
  const composerApplyTiming = String(config?.["composerApplyTiming"] ?? "onSend");
  const sidebarDefaultOpen = config?.["sidebarDefaultOpen"] === true;
  const floatCard = (config?.["floatCard"] ?? true) === true;
  const timelineCollapseDefault = (config?.["timelineCollapseDefault"] ?? true) === true;
  const showHiddenMessages = config?.["showHiddenMessages"] === true;
  const isDev = import.meta.env.DEV;
  const debugMode = config?.["debugMode"] ?? isDev;

  const update = (key: string, value: unknown): void => {
    onChange({ ...config, [key]: value });
  };

  const checkboxStyle: React.CSSProperties = {
    width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--color-primary)",
  };

  const checkbox = (key: string, value: boolean): React.ReactNode => (
    <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => update(key, e.target.checked)}
        style={checkboxStyle}
      />
      <span style={{ fontSize: "var(--font-size-sm)" }}>{value ? t("common.on") : t("common.off")}</span>
    </label>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      {appInfo && (
        <div style={{
          display: "flex", alignItems: "center", gap: "var(--spacing-md)",
          padding: "var(--spacing-sm) var(--spacing-md)",
          borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)",
          background: "var(--color-surface)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)",
        }}>
          <span style={{ fontWeight: 600, color: "var(--color-fg)" }}>{appInfo.name}</span>
          <span>v{appInfo.version}</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>Electron {appInfo.electron}</span>
          <span>Node {appInfo.node}</span>
          <span>Chrome {appInfo.chrome}</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>{appInfo.platform}{appInfo.isPackaged ? "" : " (dev)"}</span>
        </div>
      )}
      <SettingsSection title={t("settings.sectionModelInput")}>
        <OptRow name={t("settings.defaultThinkingLevel")} desc={t("settings.defaultThinkingLevelDesc")} first>
          <Select
            value={defaultThinkingLevel}
            onChange={(v) => update("defaultThinkingLevel", v)}
            ariaLabel={t("settings.defaultThinkingLevel")}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>{t(LEVEL_I18N[l])}</option>
            ))}
          </Select>
        </OptRow>
        <OptRow name={t("settings.composerApplyTiming")} desc={t("settings.composerApplyTimingDesc")}>
          <Select
            value={composerApplyTiming}
            onChange={(v) => update("composerApplyTiming", v)}
            ariaLabel={t("settings.composerApplyTiming")}
          >
            {APPLY_TIMINGS.map((v) => (
              <option key={v} value={v}>{t(APPLY_TIMING_I18N[v])}</option>
            ))}
          </Select>
        </OptRow>
      </SettingsSection>
      <SettingsSection title={t("settings.sectionInterface")}>
        <OptRow name={t("settings.sidebarDefaultOpen")} desc={t("settings.sidebarDefaultOpenDesc")} first>
          {checkbox("sidebarDefaultOpen", sidebarDefaultOpen)}
        </OptRow>
        <OptRow name={t("settings.floatCard")} desc={t("settings.floatCardDesc")}>
          {checkbox("floatCard", floatCard)}
        </OptRow>
        <OptRow name={t("settings.timelineCollapseDefault")} desc={t("settings.timelineCollapseDefaultDesc")}>
          {checkbox("timelineCollapseDefault", timelineCollapseDefault)}
        </OptRow>
        <OptRow name={t("settings.showHiddenMessages")} desc={t("settings.showHiddenMessagesDesc")}>
          {checkbox("showHiddenMessages", showHiddenMessages)}
        </OptRow>
      </SettingsSection>
      <SettingsSection title={t("settings.sectionDev")}>
        <OptRow name={t("settings.debugMode")} desc={t("settings.debugModeDesc")} first>
          {checkbox("debugMode", debugMode as boolean)}
        </OptRow>
      </SettingsSection>
    </div>
  );
}
