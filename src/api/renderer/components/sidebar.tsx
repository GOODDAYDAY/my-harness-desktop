// 左栏壳 —— sidebar 槽的渲染 chrome + 底部"设置"入口。
//
// 壳只认槽位契约:从 slots:sidebar 读贡献项(按 order 排好序来),
// 分组组件经 @pi-desktop/react 注册中心按 component 名查(插件自注册)。
// 对话/项目分组都是插件(sidebar 槽);设置入口是壳的(设置框架是核心)。
//
// 纵向布局:每个分组一个 Panel(react-resizable-panels vertical),相邻分组间一条
// 可拖拽 PanelResizeHandle —— 改高度比(非整体滚动)。
// 组内滚动分配:最后一个渲染出实际内容的项 flex-1 吃剩余空间当滚动容器(会话列表),
// 其余项 shrink-0 内容自适应固定(项目列表,不随其它项滑动),超高时 max-h 限一半
// 自己滚——防线:任何插件加进同组都不会再有"某板块内容多了不能滚动"。渲染 null 的
// 项(无运行子 agent 的 SubAgentSection)由 MutationObserver 探测为"无内容",不占
// flex 空间,滚动容器自动移交给前一个有内容的项——滚动能力不随贡献项是否为空漂移。
// 历史:sub-agents 曾把会话列表挤出滚动位(会话多了不能上下滑);空项也踩过同一坑
// (空末项占着"末项"名分把滚动容器藏了,会话被 max-h 限一半,下方留白)——滚动容器
// 按"最后可见项"分配而非数组末项。
// 复用壳横向三栏(index.tsx)同库,纵向分支零新依赖;handle 拖拽态显 primary 色。
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

// 单贡献项槽:渲染插件组件 + 探测该滚动容器内是否有实际内容。
// 探测经 MutationObserver 持续观察:插件内容从 null 变有内容(如子 agent 出现)、
// 或有内容变 null(全部结束),滚动容器的归属随之移交,不依赖父组件恰好重渲染。
// 探测判定 = 容器内是否存在元素子节点,与 CSS :empty 语义一致(渲染 null 即空)。
function SidebarItemSlot({
  item,
  isScroll,
  hidden,
  onContentChange,
}: {
  item: SidebarItem;
  isScroll: boolean;
  hidden: boolean;
  onContentChange: (id: string, hasContent: boolean) => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const divRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef(onContentChange);
  cbRef.current = onContentChange;

  useLayoutEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const check = (): void => {
      cbRef.current(item.id, el.firstElementChild != null);
    };
    // paint 前先按当前内容纠正一次(避免空项首帧占着滚动容器闪一下)
    check();
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
    // 观察生命周期随槽位挂载,不随父重渲染重建;回调走 ref 拿最新闭包
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Comp = getSidebarComponent(item.component);
  return (
    <div
      ref={divRef}
      // 滚动容器 = 最后一个有内容的项(flex-1 吃剩余空间);其余项 shrink-0 固定,
      // 超高限一半自己滚(防线)。空项(渲染 null)hidden 不占 flex 空间,
      // 滚动容器由前一个有内容的项接管——滚动能力不随贡献项是否为空漂移。
      className={`${hidden ? "hidden " : ""}${
        isScroll ? "flex-1 min-h-0 overflow-y-auto" : "shrink-0 max-h-[50%] overflow-y-auto"
      }`}
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
  // 组内各项的内容探测表:item.id -> 是否渲染出实际内容(null 渲染视为无内容)。
  // 初始为空对象 = 全项默认有内容(未探测前按数组末项分配,与旧行为一致,不闪烁)。
  const [contentMap, setContentMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void window.pi.slots.sidebar().then(setItems);
  }, [pluginsNonce]);

  // 内容探测回写:状态未变时返回原对象,React bail out,不触发多余重渲染
  const onContentChange = useCallback((id: string, has: boolean): void => {
    setContentMap((prev) => (prev[id] === has ? prev : { ...prev, [id]: has }));
  }, []);

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
            // 滚动容器 = 最后一个有内容的项;空项(渲染 null)不参与,滚动能力移交
            const lastVisibleIndex = pg.items.reduce(
              (acc, item, ii) => (contentMap[item.id] === false ? acc : ii),
              -1
            );
            return (
              <Fragment key={pg.key}>
                <Panel
                  minSize={10}
                  className="min-h-0"
                >
                  <div className="h-full flex flex-col px-2.5 pt-3 pb-2">
                    {pg.items.map((item, ii) => {
                      const hasContent = contentMap[item.id] !== false; // 默认有内容
                      return (
                        <SidebarItemSlot
                          key={item.id}
                          item={item}
                          isScroll={hasContent && ii === lastVisibleIndex}
                          hidden={!hasContent}
                          onContentChange={onContentChange}
                        />
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
