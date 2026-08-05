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


/** 行数档预设。手改 general.json 写出非档值时并入选项——value 不在 option 里 select 显示空白。 */
const LINE_PRESETS = [5, 10, 15, 20, 30];

function lineOptions(current: number): number[] {
  return LINE_PRESETS.includes(current) ? LINE_PRESETS : [...LINE_PRESETS, current].sort((a, b) => a - b);
}


function SectionGroup({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-md)" }}>
      <div style={{ fontSize: "var(--font-size-base)", fontWeight: 600, marginBottom: "var(--spacing-md)" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--spacing-md)", alignContent: "start" }}>{children}</div>
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
  const composerMaxLines = Number(config?.["composerMaxLines"] ?? 10);
  const userBubbleMaxLines = Number(config?.["userBubbleMaxLines"] ?? 10);
  const sidebarDefaultOpen = config?.["sidebarDefaultOpen"] === true;
  const floatCard = (config?.["floatCard"] ?? true) === true;
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
      <SectionGroup title={t("settings.groupSessionFlow")}>
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
      <SettingsSection title={t("settings.composerApplyTiming")} description={t("settings.composerApplyTimingDesc")}>
        <Select
          value={composerApplyTiming}
          onChange={(v) => update("composerApplyTiming", v)}
          style={{ width: "100%" }}
          ariaLabel={t("settings.composerApplyTiming")}
        >
          {APPLY_TIMINGS.map((v) => (
            <option key={v} value={v}>{t(APPLY_TIMING_I18N[v])}</option>
          ))}
        </Select>
      </SettingsSection>
      <SettingsSection title={t("settings.composerMaxLines")} description={t("settings.composerMaxLinesDesc")}>
        <Select
          value={String(composerMaxLines)}
          onChange={(v) => update("composerMaxLines", Number(v))}
          style={{ width: "100%" }}
          ariaLabel={t("settings.composerMaxLines")}
        >
          {lineOptions(composerMaxLines).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </Select>
      </SettingsSection>
      <SettingsSection title={t("settings.userBubbleMaxLines")} description={t("settings.userBubbleMaxLinesDesc")}>
        <Select
          value={String(userBubbleMaxLines)}
          onChange={(v) => update("userBubbleMaxLines", Number(v))}
          style={{ width: "100%" }}
          ariaLabel={t("settings.userBubbleMaxLines")}
        >
          {lineOptions(userBubbleMaxLines).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </Select>
      </SettingsSection>
      <SettingsSection title={t("settings.showHiddenMessages")} description={t("settings.showHiddenMessagesDesc")}>
        {checkbox("showHiddenMessages", showHiddenMessages)}
      </SettingsSection>
      <SettingsSection title={t("settings.timelineCollapseDefault")} description={t("settings.timelineCollapseDefaultDesc")}>
        {checkbox("timelineCollapseDefault", timelineCollapseDefault)}
      </SettingsSection>
      </SectionGroup>
      <SectionGroup title={t("settings.groupInterface")}>
      <SettingsSection title={t("settings.sidebarDefaultOpen")} description={t("settings.sidebarDefaultOpenDesc")}>
        {checkbox("sidebarDefaultOpen", sidebarDefaultOpen)}
      </SettingsSection>
      <SettingsSection title={t("settings.floatCard")} description={t("settings.floatCardDesc")}>
        {checkbox("floatCard", floatCard)}
      </SettingsSection>
      </SectionGroup>
      <SectionGroup title={t("settings.groupDebug")}>
      <SettingsSection title={t("settings.debugMode")} description={t("settings.debugModeDesc")}>
        {checkbox("debugMode", debugMode as boolean)}
      </SettingsSection>
      </SectionGroup>
    </div>
  );
}
