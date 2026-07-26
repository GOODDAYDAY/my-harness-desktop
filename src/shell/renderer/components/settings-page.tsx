// 设置整页 —— 读 settings 槽所有贡献项(经 pi.settings.list,来自加载器注册表),
// 左边列插件配置项 + 右边对应配置页。
//
// 依据 DESIGN.md §3.3(settings 槽:插件自己的配置页)。
// 薄壳合规修复:左列表不再硬编码、不直接 import 插件 manifest,改从加载器注册表读;
// 右区按 component 名经 settings-components 注册中心查组件(插件自注册,非手写表)。
// 加载器落地后,component 名→组件 改为加载器动态 import renderer 模块。
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useUiStore } from "../ui-store";
import { getSettingsComponent } from "../settings-components";

interface SettingsItem {
  id: string;
  title: string;
  component: string;
  pluginId: string;
}

export function SettingsPage(): React.ReactNode {
  const setMainView = useUiStore((s) => s.setMainView);
  const [items, setItems] = useState<SettingsItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  // 启动从加载器注册表读 settings 槽贡献项
  useEffect(() => {
    void window.pi.settings.list().then((list) => {
      setItems(list);
      if (list.length > 0 && !activeId) setActiveId(list[0].id);
    });
  }, [activeId]);

  const active = items.find((s) => s.id === activeId);
  const ActiveComponent = active ? getSettingsComponent(active.component) : null;

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

      {/* 主体:左列表 + 右配置区 */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div
          style={{
            width: "240px",
            flexShrink: 0,
            borderRight: "1px solid var(--color-border)",
            padding: "var(--spacing-sm) 0",
            overflowY: "auto",
          }}
        >
          {items.map((item) => {
            const activeNow = activeId === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveId(item.id)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "var(--spacing-sm) var(--spacing-lg)",
                  border: "none",
                  borderLeft: activeNow ? "2px solid var(--color-primary)" : "2px solid transparent",
                  background: activeNow ? "var(--color-surface)" : "transparent",
                  color: activeNow ? "var(--color-fg)" : "var(--color-muted)",
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

        <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
          {ActiveComponent ? <ActiveComponent /> : <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)" }}>暂无配置</div>}
        </div>
      </div>
    </div>
  );
}
