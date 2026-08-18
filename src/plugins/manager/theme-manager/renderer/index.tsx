// theme-manager 插件 renderer —— 主题/字体/会话流/侧栏风格设置(tab 化)。
//
// 经 @my-harness-desktop/react 受控 API(守薄壳 H1:不直连 shell):
// - 主题列表 → tabs 各自 usePluginContext().themes.list()
// - 主题/字体偏好 → useUiStore(经 @my-harness-desktop/react,落 electron-store)
// - 插件自身偏好(showFontPreview)→ FontTab 经 usePluginContext().config(落 plugins-data)
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelTabs, type SettingsComponentProps } from "@my-harness-desktop/react";
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
    <>
      <PanelTabs
        tabs={TABS.map((tab) => ({ label: t(tab.labelKey), value: tab.id }))}
        activeValue={activeTab}
        onChange={setActiveTab}
      />
      {activeTab === "font" && <FontTab refreshSignal={refreshSignal} />}
      {activeTab === "theme" && <ThemeTab />}
      {activeTab === "timeline" && <TimelineTab />}
      {activeTab === "sidebar" && <SidebarTab />}
      {activeTab === "sidepanel" && <SidepanelTab />}
    </>
  );
}
