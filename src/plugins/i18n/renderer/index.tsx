// i18n 插件 renderer —— 语言设置页(05-plugin-i18n)。
//
// 对称 theme-manager 的主题网格:列四语言(zh-CN/zh-TW/en/de),选中切换。
// 切语言只调 useUiStore.setCurrentLocale(落 prefs);i18next.changeLanguage 由 renderer
// 入口的 locale 订阅自动触发(插件不碰 shell/i18next,守插件式边界)。
// 纯 renderer 插件:语言槽贡献(languages)是纯声明式零代码;本 renderer 只为设置页 UI。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  registerSettingsComponent, useUiStore, SettingsSection, ListItem,
  type SettingsComponentProps,
} from "@pi-desktop/react";

registerSettingsComponent("LanguageSettings", LanguageSettings);

export function LanguageSettings({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const currentLocale = useUiStore((s) => s.currentLocale);
  const setCurrentLocale = useUiStore((s) => s.setCurrentLocale);
  const [locales, setLocales] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    void window.pi.i18n.list().then(setLocales);
  }, [refreshSignal]);

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "var(--spacing-xl)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-xl)",
      }}
    >
      <SettingsSection title={t("settings.language")} description={t("settings.languageDesc")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "var(--spacing-sm)" }}>
          {locales.map((l) => (
            <ListItem key={l.id} active={currentLocale === l.id} onClick={() => setCurrentLocale(l.id)} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", border: currentLocale === l.id ? "2px solid var(--color-primary)" : "1px solid var(--color-border)", flexShrink: 0 }} />
              {l.name}
            </ListItem>
          ))}
        </div>
      </SettingsSection>
      <div style={{ marginTop: "auto", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        {currentLocale}
      </div>
    </div>
  );
}
