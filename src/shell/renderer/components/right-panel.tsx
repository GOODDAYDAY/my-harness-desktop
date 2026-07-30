import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  DndContext, closestCenter, type DragEndEvent,
  PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { PluginIcon, getSidePanelComponent, useUiStore, PluginIdContext } from "@pi-desktop/react";

interface SidePanelItem {
  id: string;
  label: string;
  icon: string;
  component: string;
  pluginId: string;
}

const GENERAL_CONFIG_PATH = "~/.pi-desktop/config/general.json";

interface SidePanelData {
  items: SidePanelItem[];
  customOrder: string[] | null;
}

const EMPTY_DATA: SidePanelData = { items: [], customOrder: null };

let sidePanelCache: { nonce: number; data: SidePanelData } | null = null;
let sidePanelInflight: { nonce: number; promise: Promise<SidePanelData> } | null = null;

function loadSidePanelData(nonce: number): Promise<SidePanelData> {
  if (sidePanelCache && sidePanelCache.nonce === nonce) return Promise.resolve(sidePanelCache.data);
  if (!sidePanelInflight || sidePanelInflight.nonce !== nonce) {
    sidePanelInflight = {
      nonce,
      promise: Promise.all([
        window.pi.slots.sidePanel(),
        window.pi.configFile.get(GENERAL_CONFIG_PATH),
      ]).then(([loaded, cfg]) => {
        const data: SidePanelData = {
          items: loaded,
          customOrder: (cfg["sidePanelOrder"] as string[] | undefined) ?? null,
        };
        sidePanelCache = { nonce, data };
        sidePanelInflight = null;
        return data;
      }),
    };
  }
  return sidePanelInflight.promise;
}

/** Strip/Content 共享的 sidePanel 数据 hook:同 nonce 单发请求,结果共享 */
function useSidePanelData(): SidePanelData {
  // pluginsNonce 进依赖:插件启用/禁用/安装后重拉 sidePanel 槽贡献
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<SidePanelData>(
    () => (sidePanelCache && sidePanelCache.nonce === pluginsNonce ? sidePanelCache.data : EMPTY_DATA),
  );
  useEffect(() => {
    let alive = true;
    void loadSidePanelData(pluginsNonce).then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}

function applyCustomOrder(items: SidePanelItem[], customOrder: string[] | null): SidePanelItem[] {
  if (!customOrder || customOrder.length === 0) return items;
  const orderMap = new Map(customOrder.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const aIdx = orderMap.get(a.id);
    const bIdx = orderMap.get(b.id);
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;
    return 0;
  });
}

export function SidePanelStrip(): React.ReactNode {
  const sidepanelStyle = useUiStore((s) => s.sidepanelStyle);
  const { items, customOrder: sharedOrder } = useSidePanelData();
  // 拖拽排序是 Strip 的交互状态:本地覆盖,写回 configFile + 共享缓存
  const [customOrder, setCustomOrderState] = useState<string[] | null>(null);
  const effectiveOrder = customOrder ?? sharedOrder;
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const toggleSidePanelTab = useUiStore((s) => s.toggleSidePanelTab);

  const setCustomOrder = (order: string[]): void => {
    setCustomOrderState(order);
    if (sidePanelCache) sidePanelCache.data = { ...sidePanelCache.data, customOrder: order };
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const orderedItems = useMemo(() => applyCustomOrder(items, effectiveOrder), [items, effectiveOrder]);

  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  useEffect(() => {
    if (rightPanelOpen && activeTabs.length === 0 && orderedItems.length > 0) {
      toggleSidePanelTab(orderedItems[0].id);
    }
  }, [rightPanelOpen, activeTabs.length, orderedItems, toggleSidePanelTab]);

  const handleDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = orderedItems.findIndex((i) => i.id === active.id);
    const newIdx = orderedItems.findIndex((i) => i.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const newOrder = arrayMove(orderedItems, oldIdx, newIdx).map((i) => i.id);
    setCustomOrder(newOrder);
    void window.pi.configFile.set(GENERAL_CONFIG_PATH, { sidePanelOrder: newOrder }, "deep");
  };

  if (orderedItems.length === 0) return null;

  return (
    <div data-sidepanel-style={sidepanelStyle} className="flex flex-col items-center gap-1.5 py-3 w-12 shrink-0 bg-[var(--color-chrome)] border-l border-[var(--color-border)]" style={{ gap: "var(--sidepanel-icon-gap)" }}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedItems.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          {orderedItems.map((item) => (
            <SortableIcon
              key={item.id}
              item={item}
              isActive={activeTabs.includes(item.id)}
              onClick={() => toggleSidePanelTab(item.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableIcon({ item, isActive, onClick }: {
  item: SidePanelItem;
  isActive: boolean;
  onClick: () => void;
}): React.ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
    position: "relative",
  };

  return (
    <div ref={setNodeRef} style={style}>
      <button
        {...attributes}
        {...listeners}
        onClick={onClick}
        title={item.label}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "var(--sidepanel-icon-btn-size)",
          height: "var(--sidepanel-icon-btn-size)",
          borderRadius: "var(--sidepanel-icon-btn-radius)",
          border: "var(--sidepanel-icon-btn-border)",
          background: isActive ? "var(--sidepanel-icon-btn-bg-active)" : "var(--sidepanel-icon-btn-bg)",
          backdropFilter: "var(--sidepanel-glass-blur, none)",
          color: isActive ? "var(--color-fg)" : "var(--color-muted)",
          cursor: "pointer",
          transition: "background 0.15s, color 0.15s, border-color 0.15s",
          touchAction: "none",
        }}
      >
        {isActive && (
          <span style={{
            position: "absolute",
            left: 0,
            top: "50%",
            transform: "translateY(-50%)",
            height: "var(--sidepanel-icon-active-indicator-height)",
            borderLeft: "var(--sidepanel-icon-active-indicator)",
            borderRadius: "0 2px 2px 0",
          }} className="sidepanel-indicator-in" />
        )}
        <PluginIcon name={item.icon} style={{ width: "var(--sidepanel-icon-size)", height: "var(--sidepanel-icon-size)" }} />
      </button>
    </div>
  );
}

export function RightPanelContent(): React.ReactNode {
  const { t } = useTranslation();
  const sidepanelStyle = useUiStore((s) => s.sidepanelStyle);
  const { items, customOrder } = useSidePanelData();
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const [handleDragging, setHandleDragging] = useState(false);

  const orderedItems = useMemo(
    () => applyCustomOrder(items.filter((i) => activeTabs.includes(i.id)), customOrder),
    [items, activeTabs, customOrder],
  );

  // 关闭动画(G-20260201-03):tab 关闭时 Panel 瞬间从 PanelGroup 消失,没有过渡。
  // 保留 exiting 快照延后卸载:先按 exit keyframes 淡出,期间占位不跳布局,
  // 240ms 动画播完再真正从 PanelGroup 移除。进入侧由 .sidepanel-panel-enter 兜底。
  const prevIdsRef = useRef<string[]>([]);
  const [exitingIds, setExitingIds] = useState<string[]>([]);
  useEffect(() => {
    const cur = orderedItems.map((x) => x.id);
    const removed = prevIdsRef.current.filter((id: string) => !cur.includes(id));
    prevIdsRef.current = cur;
    if (removed.length === 0) return undefined;
    setExitingIds((ex) => [...new Set([...ex, ...removed])]);
    const timer = setTimeout(() => setExitingIds((ex) => ex.filter((x) => !removed.includes(x))), 240);
    return () => clearTimeout(timer);
  }, [orderedItems]);

  const exitingItems = useMemo(
    () => items.filter((x) => exitingIds.includes(x.id) && !activeTabs.includes(x.id)),
    [items, exitingIds, activeTabs],
  );

  if (orderedItems.length === 0 && exitingItems.length === 0) {
    return <div className="h-full bg-[var(--color-chrome)]" />;
  }

  return (
    <div data-sidepanel-style={sidepanelStyle} className="h-full flex flex-col bg-[var(--color-chrome)]">
      <PanelGroup direction="vertical" className="h-full" autoSaveId="right-panel-v">
        {orderedItems.map((item, i) => {
          const Comp = getSidePanelComponent(item.component);
          return (
            <Fragment key={item.id}>
              <Panel minSize={10} className="min-h-0">
                <div className="h-full flex flex-col min-h-0 sidepanel-panel-enter">
                  <div
                    className="flex items-center gap-2 shrink-0 select-none cursor-pointer transition-colors"
                    style={{
                      padding: "var(--sidepanel-header-py) var(--sidepanel-header-px)",
                      borderBottom: "var(--sidepanel-header-border)",
                      background: "var(--sidepanel-header-bg)",
                      backdropFilter: "var(--sidepanel-glass-blur, none)",
                      fontSize: "var(--sidepanel-header-fs)",
                      fontWeight: "var(--sidepanel-header-fw)",
                      color: "var(--color-fg)",
                    }}
                    onClick={() => useUiStore.getState().toggleSidePanelTab(item.id)}
                  >
                    <PluginIcon name={item.icon} className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto min-h-0" style={{ padding: "var(--sidepanel-content-py) var(--sidepanel-content-px)" }}>
                    {Comp ? (
                      <PluginIdContext.Provider value={item.pluginId}>
                        <Comp isActive={true} />
                      </PluginIdContext.Provider>
                    ) : (
                      <div className="p-4 text-[var(--color-muted)] text-[var(--font-size-sm)]">
                        {t("shell.componentNotRegistered", { component: item.component, plugin: item.pluginId })}
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
              {i < orderedItems.length - 1 && (
                <PanelResizeHandle
                  onDragging={setHandleDragging}
                  style={{
                    height: "8px",
                    cursor: "row-resize",
                    background: "transparent",
                    display: "var(--sidepanel-divider-display)",
                    alignItems: "center",
                    transition: "background 0.15s",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: "var(--divider-width)",
                      margin: "0 var(--divider-inset)",
                      background: handleDragging ? "var(--color-primary)" : "var(--sidepanel-divider-color)",
                      borderRadius: "var(--radius-sm)",
                      transition: "background 0.15s",
                    }}
                  />
                </PanelResizeHandle>
              )}
            </Fragment>
          );
        })}
        {exitingItems.map((item) => {
          const Comp = getSidePanelComponent(item.component);
          return (
            <Panel key={item.id} minSize={0} className="min-h-0 sidepanel-panel-exit">
              <div className="h-full flex flex-col min-h-0">
                <div
                  className="flex items-center gap-2 shrink-0 select-none"
                  style={{
                    padding: "var(--sidepanel-header-py) var(--sidepanel-header-px)",
                    borderBottom: "var(--sidepanel-header-border)",
                    background: "var(--sidepanel-header-bg)",
                    backdropFilter: "var(--sidepanel-glass-blur, none)",
                    fontSize: "var(--sidepanel-header-fs)",
                    fontWeight: "var(--sidepanel-header-fw)",
                    color: "var(--color-fg)",
                  }}
                >
                  <PluginIcon name={item.icon} className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </div>
                <div className="flex-1 overflow-hidden min-h-0" style={{ padding: "var(--sidepanel-content-py) var(--sidepanel-content-px)" }}>
                  {Comp ? (
                    <PluginIdContext.Provider value={item.pluginId}>
                      <Comp isActive={false} />
                    </PluginIdContext.Provider>
                  ) : (
                    <div className="p-4 text-[var(--color-muted)] text-[var(--font-size-sm)]">
                      {t("shell.componentNotRegistered", { component: item.component, plugin: item.pluginId })}
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          );
        })}
      </PanelGroup>
    </div>
  );
}
