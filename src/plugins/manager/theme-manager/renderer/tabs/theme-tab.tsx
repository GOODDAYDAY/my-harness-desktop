// 主题 tab:全局主题选择(ThemePreviewCard 网格)。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  usePluginContext,
} from "@my-harness-desktop/react";
import { ThemePreviewCard } from "../theme-preview";

export function ThemeTab(): React.ReactNode {
  const { t } = useTranslation();
  const { currentThemeId, setCurrentThemeId } = useUiStore();
  const ctx = usePluginContext();
  const [themeOptions, setThemeOptions] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    void ctx.themes.list().then(setThemeOptions);
  }, [ctx]);

  return (
    <SettingsSection title={t("settings.theme")} description={t("settings.themeDesc")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "var(--spacing-md)" }}>
        {themeOptions.map((opt) => (
          <ThemePreviewCard
            key={opt.id}
            themeId={opt.id}
            label={opt.name.includes(".") ? t(opt.name, { defaultValue: opt.name }) : opt.name}
            active={currentThemeId === opt.id}
            onSelect={() => setCurrentThemeId(opt.id)}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
