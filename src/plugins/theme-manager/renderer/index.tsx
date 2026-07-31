// theme-manager 插件 renderer —— 主题/字体/会话流/侧栏风格设置(tab 化)。
//
// 经 @pi-desktop/react 受控 API(守薄壳 H1:不直连 shell):
// - 主题列表 → tabs 各自 usePluginContext().themes.list()
// - 主题/字体偏好 → useUiStore(经 @pi-desktop/react,落 electron-store)
// - 本插件偏好(showFontPreview)→ FontTab 经 usePluginContext().config(落 plugins-data)
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsComponentProps } from "@pi-desktop/react";
import { FontTab } from "./tabs/font-tab";
import { ThemeTab } from "./tabs/theme-tab";
import { TimelineTab } from "./tabs/timeline-tab";
import { SidebarTab } from "./tabs/sidebar-tab";
import { SidepanelTab } from "./tabs/sidepanel-tab";

/** tab 清单:labelKey 复用现有 section 标题 i18n key。 */
const TABS = [
  { id: "font", labelKey: "settings.font" },
  { id: "theme", labelKey: "settings.theme" },
  { id: "timeline", labelKey: "settings.timelineTheme" },
  { id: "sidebar", labelKey: "settings.sidebarStyle" },
  { id: "sidepanel", labelKey: "settings.sidepanelStyle" },
] as const;

export function ThemeSettings({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<string>("font");

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
      <div style={{ display: "flex", gap: "var(--spacing-xs)", flexWrap: "wrap" }}>
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "var(--spacing-xs) var(--spacing-md)",
                border: `1px solid ${active ? "var(--color-list-selected-border)" : "var(--color-border)"}`,
                borderRadius: "var(--radius-sm)",
                background: active ? "var(--color-list-selected-bg)" : "transparent",
                color: "var(--color-fg)",
                fontSize: "var(--font-size-sm)",
                fontWeight: active ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {activeTab === "font" && <FontTab refreshSignal={refreshSignal} />}
      {activeTab === "theme" && <ThemeTab />}
      {activeTab === "timeline" && <TimelineTab />}
      {activeTab === "sidebar" && <SidebarTab />}
      {activeTab === "sidepanel" && <SidepanelTab />}
    </div>
  );
}
