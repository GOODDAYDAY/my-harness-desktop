import type { ReactNode } from "react";
import { SettingsSection, type SettingsComponentProps } from "@pi-desktop/react";
import { useTranslation } from "react-i18next";

export function SubAgentSettings({ config, onChange }: SettingsComponentProps): ReactNode {
  const { t } = useTranslation();
  const maxConcurrent = Number(config?.maxConcurrent ?? 5);
  const timeoutMinutes = Number(config?.timeoutMinutes ?? 10);

  const patch = (key: string, value: number): void => {
    onChange({ ...(config ?? {}), [key]: value });
  };

  return (
    <SettingsSection title={t("sub-agent.settings.guards")} description={t("sub-agent.settings.guardsDesc")}>
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-3">
          <span className="w-32 text-[length:var(--font-size-sm)]">{t("sub-agent.settings.maxConcurrent")}</span>
          <input
            type="number" min={1} max={20} value={maxConcurrent}
            onChange={(e) => patch("maxConcurrent", Number(e.target.value))}
            className="w-20 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-3">
          <span className="w-32 text-[length:var(--font-size-sm)]">{t("sub-agent.settings.timeoutMinutes")}</span>
          <input
            type="number" min={1} max={120} value={timeoutMinutes}
            onChange={(e) => patch("timeoutMinutes", Number(e.target.value))}
            className="w-20 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
          />
        </label>
      </div>
    </SettingsSection>
  );
}
