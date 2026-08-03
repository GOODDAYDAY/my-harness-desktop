// 左栏壳 —— sidebar 槽的渲染 chrome + 底部"设置"入口。
//
// 壳只认槽位契约:从 slots:sidebar 读贡献项(按 order 排好序来),
// 分组组件经 @pi-desktop/react 注册中心按 component 名查(插件自注册)。
// 对话/项目分组都是插件(sidebar 槽);设置入口是壳的(设置框架是核心)。
//
// 纵向布局:每个分组一个 Panel(react-resizable-panels vertical),各自独立滚动,
// 相邻分组间一条可拖拽 PanelResizeHandle —— 改高度比(非整体滚动)。
// 复用壳横向三栏(index.tsx)同库,纵向分支零新依赖;handle 拖拽态显 primary 色。
import { Fragment, useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useUiStore, getSidebarComponent, PluginIdContext } from "@pi-desktop/react";
import { ChatRow } from "../ui/chat-row";

interface SidebarItem {
  id: string;
  title: string;
  component: string;
  pluginId: string;
  group?: string;
}

interface PanelGroup_ {
  key: string;
  items: SidebarItem[];
}

function groupItems(items: SidebarItem[]): PanelGroup_[] {
  const groups: PanelGroup_[] = [];
  const byKey = new Map<string, PanelGroup_>();
  for (const item of items) {
    const key = item.group ?? item.id;
    let g = byKey.get(key);
    if (!g) {
      g = { key, items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}

export function Sidebar(): React.ReactNode {
  const { t } = useTranslation();
  const setActiveView = useUiStore((s) => s.setActiveView);
  const sidebarStyle = useUiStore((s) => s.sidebarStyle);
  // pluginsNonce 进 effect 依赖:插件启用/禁用/安装后重拉 sidebar 槽贡献
  // (与 titlebar 同一模式;只订阅重渲染不够,items 是 useEffect 拉的快照)
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SidebarItem[]>([]);
  const [handleDragging, setHandleDragging] = useState(false);

  useEffect(() => {
    void window.pi.slots.sidebar().then(setItems);
  }, [pluginsNonce]);

  const panelGroups = groupItems(items);

  return (
    <div
      data-sidebar-style={sidebarStyle}
      className="flex flex-col h-full w-full border-r border-[var(--color-border)]"
      style={{
        background: "var(--color-chrome)",
        "--font-size-xs": "calc(var(--font-size-xs-raw) * var(--sidebar-font-scale, 1))",
        "--font-size-sm": "calc(var(--font-size-sm-raw) * var(--sidebar-font-scale, 1))",
        "--font-size-base": "calc(var(--font-size-base-raw) * var(--sidebar-font-scale, 1))",
        "--font-size-lg": "calc(var(--font-size-lg-raw) * var(--sidebar-font-scale, 1))",
        "--sidebar-section-fs": "calc(var(--font-size-sm-raw) * var(--sidebar-font-scale, 1))",
      } as React.CSSProperties}
    >
      <div className="flex-1 min-h-0">
        <PanelGroup direction="vertical" className="h-full" autoSaveId="sidebar-v">
          {panelGroups.map((pg, gi) => {
            const isLast = gi === panelGroups.length - 1;
            return (
              <Fragment key={pg.key}>
                <Panel
                  minSize={10}
                  className="min-h-0"
                >
                  <div className="h-full flex flex-col px-2.5 pt-3 pb-2">
                    {pg.items.map((item, ii) => {
                      const Comp = getSidebarComponent(item.component);
                      const itemLast = ii === pg.items.length - 1;
                      return (
                        <div
                          key={item.id}
                          className={itemLast ? "flex-1 min-h-0 overflow-y-auto" : "shrink-0"}
                        >
                          {Comp ? (
                            <PluginIdContext.Provider value={item.pluginId}>
                              <Comp />
                            </PluginIdContext.Provider>
                          ) : (
                            <div className="px-2 py-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
                              {t("shell.componentNotRegistered", { component: item.component, plugin: item.pluginId })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Panel>
                {!isLast && (
                  <PanelResizeHandle
                    onDragging={setHandleDragging}
                    style={{
                      height: "8px",
                      cursor: "row-resize",
                      background: "transparent",
                      display: "var(--sidebar-divider-display)",
                      alignItems: "center",
                      transition: "background 0.15s",
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        height: "var(--divider-width)",
                        margin: "0 var(--divider-inset)",
                        background: handleDragging
                          ? "var(--color-primary)"
                          : "var(--divider-color)",
                        borderRadius: "var(--radius-sm)",
                        transition: "background 0.15s",
                      }}
                    />
                  </PanelResizeHandle>
                )}
              </Fragment>
            );
          })}
        </PanelGroup>
      </div>

      <div className="border-t border-[var(--color-border)] shrink-0 px-2 py-2">
        <ChatRow onClick={() => setActiveView("settings")} icon={<Settings className="size-4.5" />}>
          {t("shell.settings")}
        </ChatRow>
      </div>
    </div>
  );
}
