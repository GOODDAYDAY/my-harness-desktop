// 会话流主题 tab:会话流(mainView)独立主题选择。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  ListItem,
  usePluginContext,
  TIMELINE_CONTENT_MIN_PX,
  TIMELINE_CONTENT_MAX_PX,
} from "@pi-desktop/react";
import { ThemePreviewCard } from "../theme-preview";

export function TimelineTab(): React.ReactNode {
  const { t } = useTranslation();
  const { timelineThemeId, setTimelineThemeId, timelineContentWidth, setTimelineContentWidth } = useUiStore();
  const ctx = usePluginContext();
  const [themeOptions, setThemeOptions] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    void ctx.themes.list().then(setThemeOptions);
  }, [ctx]);

  return (
    <>
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

      <SettingsSection title={t("settings.timelineContentWidth")} description={t("settings.timelineContentWidthDesc")}>
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            {t("settings.timelineContentWidth")} · {timelineContentWidth}px
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={TIMELINE_CONTENT_MIN_PX} max={TIMELINE_CONTENT_MAX_PX} step={20} value={timelineContentWidth}
              onChange={(e) => setTimelineContentWidth(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>{TIMELINE_CONTENT_MIN_PX}px</span><span>{TIMELINE_CONTENT_MAX_PX}px</span>
            </div>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}
