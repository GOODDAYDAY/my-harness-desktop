// app-restart 插件 renderer —— 「应用」设置页:应用信息展示 + 整 App 重启入口。
// 重启机制在内核(app:restart 通道,main relaunch 后经 before-quit 回收链退出);
// 本页只呈现信息与发起两步确认动作,saveMode=manual,不涉及配置读写。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Power } from "lucide-react";
import {
  SettingsSection,
  usePluginContext,
  type AppInfo,
  type SettingsComponentProps,
} from "@pi-desktop/react";

export function AppRestartPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    void ctx.appInfo.get().then(setInfo);
  }, [ctx.appInfo, refreshSignal]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  const onRestart = useCallback(() => {
    if (armed) void ctx.appInfo.restart();
    else setArmed(true);
  }, [armed, ctx.appInfo]);

  const rows: [string, string][] = info
    ? [
        ["name", info.name],
        ["version", info.version],
        ["electron", info.electron],
        ["node", info.node],
        ["chrome", info.chrome],
        ["platform", info.platform],
        ["isPackaged", info.isPackaged ? t("appRestart.packaged") : t("appRestart.dev")],
      ]
    : [];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)", display: "flex", flexDirection: "column", gap: "var(--spacing-xl)" }}>
      <SettingsSection
        title={t("appRestart.sectionInfo")}
        description={t("appRestart.sectionInfoDesc")}
        actions={
          <button
            onClick={onRestart}
            title={armed ? t("appRestart.restartConfirm") : t("appRestart.restart")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-xs)",
              padding: "var(--spacing-xs) var(--spacing-sm)",
              border: `1px solid ${armed ? "var(--color-error)" : "var(--color-border)"}`,
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: armed ? "var(--color-error)" : "var(--color-muted)",
              cursor: "pointer",
              fontSize: "var(--font-size-sm)",
            }}
          >
            <Power size={14} />
            {armed ? t("appRestart.restartConfirm") : t("appRestart.restart")}
          </button>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", padding: "var(--spacing-sm) var(--spacing-md)" }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)" }}>
              <span style={{ color: "var(--color-muted)" }}>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </SettingsSection>
      <div style={{ marginTop: "auto", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        {t("appRestart.restartDesc")}
      </div>
    </div>
  );
}
