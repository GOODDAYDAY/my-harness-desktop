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
import { PluginIcon, getSidePanelComponent, useUiStore } from "@pi-desktop/react";

interface SidePanelItem {
  id: string;
  label: string;
  icon: string;
  component: string;
  pluginId: string;
}

const GENERAL_CONFIG_PATH = "~/.pi-desktop/config/general.json";

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
  useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SidePanelItem[]>([]);
  const [customOrder, setCustomOrder] = useState<string[] | null>(null);
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleSidePanelTab = useUiStore((s) => s.toggleSidePanelTab);
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    void Promise.all([
      window.pi.slots.sidePanel(),
      window.pi.configFile.get(GENERAL_CONFIG_PATH),
    ]).then(([loaded, cfg]) => {
      setItems(loaded);
      setCustomOrder((cfg["sidePanelOrder"] as string[] | undefined) ?? null);
    });
  }, []);

  const orderedItems = useMemo(() => applyCustomOrder(items, customOrder), [items, customOrder]);

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
              onClick={() => {
                if (activeTabs.includes(item.id)) {
                  toggleSidePanelTab(item.id);
                  if (activeTabs.length === 1) setRightPanelOpen(false);
                } else {
                  if (!rightPanelOpen) setRightPanelOpen(true);
                  toggleSidePanelTab(item.id);
                }
              }}
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
  const [showTip, setShowTip] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleEnter = (): void => {
    timerRef.current = setTimeout(() => setShowTip(true), 1000);
  };
  const handleLeave = (): void => {
    clearTimeout(timerRef.current);
    setShowTip(false);
  };
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
    position: "relative",
  };

  return (
    <div ref={setNodeRef} style={style} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
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
          color: isActive ? "var(--color-fg)" : "var(--color-muted)",
          cursor: "pointer",
          transition: "background 0.15s, color 0.15s, border-color 0.15s",
          touchAction: "none",
        }}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      >
        {isActive && (
          <span style={{
            position: "absolute",
            left: 0,
            top: "50%",
            transform: "translateY(-50%)",
            height: "20px",
            borderLeft: "var(--sidepanel-icon-active-indicator)",
            borderRadius: "0 2px 2px 0",
          }} />
        )}
        <PluginIcon name={item.icon} style={{ width: "var(--sidepanel-icon-size)", height: "var(--sidepanel-icon-size)" }} />
      </button>
      {showTip && !isDragging && (
        <div
          className="absolute right-full top-1/2 -translate-y-1/2 mr-2 px-2 py-1 rounded-[var(--radius-sm)] text-[var(--font-size-xs)] whitespace-nowrap pointer-events-none z-[100]"
          style={{
            background: "var(--color-surface)",
            color: "var(--color-fg)",
            border: "1px solid var(--color-border)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          {item.label}
        </div>
      )}
    </div>
  );
}

export function RightPanelContent(): React.ReactNode {
  const sidepanelStyle = useUiStore((s) => s.sidepanelStyle);
  useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SidePanelItem[]>([]);
  const [customOrder, setCustomOrder] = useState<string[] | null>(null);
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const [handleDragging, setHandleDragging] = useState(false);

  useEffect(() => {
    void Promise.all([
      window.pi.slots.sidePanel(),
      window.pi.configFile.get(GENERAL_CONFIG_PATH),
    ]).then(([loaded, cfg]) => {
      setItems(loaded);
      setCustomOrder((cfg["sidePanelOrder"] as string[] | undefined) ?? null);
    });
  }, []);

  const orderedItems = useMemo(
    () => applyCustomOrder(items.filter((i) => activeTabs.includes(i.id)), customOrder),
    [items, activeTabs, customOrder],
  );

  if (orderedItems.length === 0) {
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
                <div className="h-full flex flex-col min-h-0">
                  <div
                    className="flex items-center gap-2 shrink-0 select-none cursor-pointer transition-colors"
                    style={{
                      padding: "var(--sidepanel-header-py) var(--sidepanel-header-px)",
                      borderBottom: "var(--sidepanel-header-border)",
                      background: "var(--sidepanel-header-bg)",
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
                    {Comp ? <Comp /> : (
                      <div className="p-4 text-[var(--color-muted)] text-[var(--font-size-sm)]">
                        组件未注册: {item.component}（插件 {item.pluginId}）
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
      </PanelGroup>
    </div>
  );
}
