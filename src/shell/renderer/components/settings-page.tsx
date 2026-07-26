// 设置整页 —— 读 settings 槽所有贡献项,左列表 + 右配置区。
//
// 框架级(改动 1):
// - 切 tab 不重载:所有 settings 组件都渲染,非 active 用 display:none 隐藏(不卸载),
//   useEffect 只在首次 mount 跑一次,切回来不重新拉数据。
// - 右上角刷新按钮:每个 active 区顶部一个刷新按钮,点 → refreshSignal+1 → 组件 useEffect 重拉。
// - 组件接受 refreshSignal prop(框架统一刷新机制)。
//
// 依据 DESIGN.md §3.3(settings 槽)。加载器落地后 component 名→组件 改为加载器动态 import。
import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useUiStore } from "../ui-store";
import { getSettingsComponent, type SettingsComponentProps } from "@pi-desktop/react";

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
  const [refreshSignal, setRefreshSignal] = useState(0);

  // 启动从加载器注册表读 settings 槽贡献项(只 mount 拉一次)
  useEffect(() => {
    void window.pi.settings.list().then((list) => {
      setItems(list);
      setActiveId((prev) => prev || (list.length > 0 ? list[0].id : ""));
    });
  }, []);

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
            display: "flex", alignItems: "center", gap: "var(--spacing-xs)",
            border: "none", background: "transparent", color: "var(--color-muted)",
            cursor: "pointer", fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
            padding: "var(--spacing-xs) var(--spacing-sm)", borderRadius: "var(--radius-sm)",
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
        {/* 左:插件配置项列表 */}
        <div
          style={{
            width: "240px", flexShrink: 0, borderRight: "1px solid var(--color-border)",
            padding: "var(--spacing-sm) 0", overflowY: "auto",
          }}
        >
          {items.map((item) => {
            const activeNow = activeId === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveId(item.id)}
                style={{
                  display: "block", width: "100%",
                  padding: "var(--spacing-sm) var(--spacing-lg)",
                  border: "none",
                  borderLeft: activeNow ? "2px solid var(--color-primary)" : "2px solid transparent",
                  background: activeNow ? "var(--color-surface)" : "transparent",
                  color: activeNow ? "var(--color-fg)" : "var(--color-muted)",
                  cursor: "pointer", fontFamily: "var(--font-family-sans)",
                  fontSize: "var(--font-size-sm)", textAlign: "left",
                }}
              >
                {item.title}
              </button>
            );
          })}
        </div>

        {/* 右:配置区。所有组件都渲染,active 的显示、其余 display:none(切 tab 不重 mount) */}
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {/* 右上角刷新按钮(只对 active 项显示) */}
          {activeId && (
            <button
              onClick={() => setRefreshSignal((s) => s + 1)}
              title="刷新"
              style={{
                position: "absolute", top: "var(--spacing-sm)", right: "var(--spacing-md)",
                zIndex: 10, display: "flex", alignItems: "center", justifyContent: "center",
                width: "28px", height: "28px",
                border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
                background: "transparent", color: "var(--color-muted)", cursor: "pointer",
              }}
            >
              <RefreshCw size={14} />
            </button>
          )}
          {items.map((item) => {
            const Comp = getSettingsComponent(item.component);
            if (!Comp) return null;
            const active = activeId === item.id;
            return (
              <div key={item.id} style={{ display: active ? "block" : "none", height: "100%" }}>
                <Comp refreshSignal={refreshSignal} />
              </div>
            );
          })}
          {items.length > 0 && !items.some((i) => i.id === activeId && getSettingsComponent(i.component)) && (
            <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)" }}>暂无配置</div>
          )}
        </div>
      </div>
    </div>
  );
}
