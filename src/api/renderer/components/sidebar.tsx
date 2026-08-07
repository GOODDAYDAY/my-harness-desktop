// 左栏壳 —— sidebar 槽的渲染 chrome + 底部"设置"入口。
//
// 壳只认槽位契约:从 slots:sidebar 读贡献项(按 order 排好序来),
// 分组组件经 @pi-desktop/react 注册中心按 component 名查(插件自注册)。
// 对话/项目分组都是插件(sidebar 槽);设置入口是壳的(设置框架是核心)。
//
// 纵向布局:每个分组一个 Panel(react-resizable-panels vertical),相邻分组间一条
// 可拖拽 PanelResizeHandle —— 改高度比(非整体滚动)。
// 组内滚动分配:末项 flex-1 吃剩余空间当滚动容器(会话列表),非末项 shrink-0 内容
// 自适应固定(项目列表,不随其它项滑动),超高时 max-h 限一半自己滚——防线:任何
// 插件加进同组都不会再有"某板块内容多了不能滚动"。empty:hidden 让渲染 null 的
// 项(无运行子 agent 的 SubAgentSection)不占 flex 空间。
// 历史:sub-agents 曾把会话列表挤出滚动位(会话多了不能上下滑)——壳层滚动分配
// 不再假设"末项=唯一滚动项":末项吃剩余滚动,非末项内容自适应固定(项目板块不随
// 其它项滑动),超高时限高一半自己滚(防线:任何插件加进同组都保留滚动能力)。
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
                          // 末项吃剩余空间当滚动容器(如会话列表);非末项内容自适应固定高度
                          // (如项目列表,不随其它项滚动),超高时限高一半自己滚(防线:任一非末项
                          // 内容爆量都不至于撑破 Panel)。empty:hidden 让渲染 null 的项
                          // (无运行子 agent 的 SubAgentSection)不占 flex 空间。
                          className={itemLast
                            ? "flex-1 min-h-0 overflow-y-auto empty:hidden"
                            : "shrink-0 max-h-[50%] overflow-y-auto empty:hidden"}
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
