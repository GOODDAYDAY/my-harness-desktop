// 会话流主题 tab:会话流(mainView)独立主题选择。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  ListItem,
  usePluginContext,
  AREA_FONT_SCALE_MIN,
  AREA_FONT_SCALE_MAX,
} from "@pi-desktop/react";
import { ThemePreviewCard } from "../theme-preview";

export function TimelineTab(): React.ReactNode {
  const { t } = useTranslation();
  const { timelineThemeId, setTimelineThemeId, timelineFontScale, setTimelineFontScale } = useUiStore();
  const ctx = usePluginContext();
  const [themeOptions, setThemeOptions] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    void ctx.themes.list().then(setThemeOptions);
  }, [ctx]);

  return (
    <>
      <SettingsSection title={t("settings.timelineFontScale")} description={t("settings.timelineFontScaleDesc")}>
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            {t("settings.timelineFontScale")} · {timelineFontScale.toFixed(2)}
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={AREA_FONT_SCALE_MIN} max={AREA_FONT_SCALE_MAX} step={0.05} value={timelineFontScale}
              onChange={(e) => setTimelineFontScale(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>{t("settings.fontSmall")}</span><span>{t("settings.fontLarge")}</span>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.timelineTheme")} description={t("settings.timelineThemeDesc")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "var(--spacing-md)" }}>
          <ListItem
            active={timelineThemeId === "__inherit__"}
            onClick={() => setTimelineThemeId("__inherit__")}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "var(--spacing-xs)", padding: "var(--spacing-sm)", minHeight: "240px" }}
          >
            <div style={{ fontSize: "24px", color: "var(--color-primary)", lineHeight: 1 }}>↩︎</div>
            <div style={{ fontSize: "var(--font-size-sm)", fontWeight: 600 }}>{t("settings.timelineThemeInherit")}</div>
            <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", textAlign: "center" }}>{t("settings.timelineThemeInheritDesc")}</div>
          </ListItem>
          {themeOptions.map((opt) => (
            <ThemePreviewCard
              key={opt.id}
              themeId={opt.id}
              label={opt.name.includes(".") ? t(opt.name, { defaultValue: opt.name }) : opt.name}
              active={timelineThemeId === opt.id}
              onSelect={() => setTimelineThemeId(opt.id)}
            />
          ))}
        </div>
      </SettingsSection>
    </>
  );
}
