// 设置整页 —— 读 settings 槽所有贡献项,左边列插件配置项 + 右边对应配置页。
//
// 依据 DESIGN.md §3.3(settings 槽:插件自己的配置页)。
// 第一步只有 theme-manager 贡献一项(component=ThemeSettings)。
// 左列表项来自 settings 槽贡献(非硬编码),右区按 component 名经注册表映射组件。
// 加载器落地后,settings 槽贡献项从加载器发现,component 字段动态 import renderer 模块;
// 当前精简:import theme-manager 的 plugin.json 取 contributes.settings,注册表映射名→组件。
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useUiStore } from "../ui-store";
import { ThemeSettings } from "../../../plugins/theme-manager/renderer";
import themeManagerManifest from "../../../plugins/theme-manager/plugin.json";

/** settings 槽贡献项(DESIGN.md §3.3 / 952 行)。 */
interface SettingsContribution {
  id: string;
  title: string;
  component: string;
}

/** 从 theme-manager 的 manifest 取 settings 槽贡献项(精简,等加载器落地后改加载器发现)。 */
const SETTINGS_ITEMS: SettingsContribution[] = (themeManagerManifest.contributes?.settings ?? []) as SettingsContribution[];

/** component 名 → 组件 注册表(精简模拟加载器按名解析组件)。 */
const COMPONENT_REGISTRY: Record<string, () => React.ReactNode> = {
  ThemeSettings: ThemeSettings,
};

export function SettingsPage(): React.ReactNode {
  const setMainView = useUiStore((s) => s.setMainView);
  const [activeId, setActiveId] = useState<string>(SETTINGS_ITEMS[0]?.id ?? "");

  const ActiveComponent = SETTINGS_ITEMS.find((s) => s.id === activeId)
    ? COMPONENT_REGISTRY[SETTINGS_ITEMS.find((s) => s.id === activeId)!.component]
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-family-sans)" }}>
      {/* 顶部:返回栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-sm)",
          padding: "var(--spacing-sm) var(--spacing-lg)",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => setMainView("chat")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-xs)",
            border: "none",
            background: "transparent",
            color: "var(--color-muted)",
            cursor: "pointer",
            fontFamily: "var(--font-family-sans)",
            fontSize: "var(--font-size-sm)",
            padding: "var(--spacing-xs) var(--spacing-sm)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <ArrowLeft size={16} />
          返回对话
        </button>
        <div style={{ marginLeft: "auto", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          设置
        </div>
      </div>

      {/* 主体:左列表 + 右配置区,都铺满 */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 左:插件配置项列表(来自 settings 槽) */}
        <div
          style={{
            width: "240px",
            flexShrink: 0,
            borderRight: "1px solid var(--color-border)",
            padding: "var(--spacing-sm) 0",
            overflowY: "auto",
          }}
        >
          {SETTINGS_ITEMS.map((item) => {
            const active = activeId === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveId(item.id)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "var(--spacing-sm) var(--spacing-lg)",
                  border: "none",
                  borderLeft: active ? "2px solid var(--color-primary)" : "2px solid transparent",
                  background: active ? "var(--color-surface)" : "transparent",
                  color: active ? "var(--color-fg)" : "var(--color-muted)",
                  cursor: "pointer",
                  fontFamily: "var(--font-family-sans)",
                  fontSize: "var(--font-size-sm)",
                  textAlign: "left",
                }}
              >
                {item.title}
              </button>
            );
          })}
        </div>

        {/* 右:选中项的配置页,铺满 */}
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
          {ActiveComponent ? <ActiveComponent /> : <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)" }}>暂无配置</div>}
        </div>
      </div>
    </div>
  );
}
