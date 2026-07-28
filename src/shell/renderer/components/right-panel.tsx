import { Fragment, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { PluginIcon, getSidePanelComponent, useUiStore } from "@pi-desktop/react";

interface SidePanelItem {
  id: string;
  label: string;
  icon: string;
  component: string;
  pluginId: string;
}

export function SidePanelStrip(): React.ReactNode {
  useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SidePanelItem[]>([]);
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleSidePanelTab = useUiStore((s) => s.toggleSidePanelTab);
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);

  useEffect(() => {
    void window.pi.slots.sidePanel().then(setItems);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-1 py-2 w-12 shrink-0 bg-[var(--color-chrome)] border-l border-[var(--color-border)]">
      {items.map((item) => {
        const isActive = activeTabs.includes(item.id);
        return (
          <button
            key={item.id}
            onClick={() => {
              if (isActive && rightPanelOpen) {
                toggleSidePanelTab(item.id);
              } else {
                setRightPanelOpen(true);
                if (!isActive) toggleSidePanelTab(item.id);
              }
            }}
            title={item.label}
            className={`flex items-center justify-center w-9 h-9 rounded-[var(--radius-sm)] cursor-pointer border-none transition-colors ${
              isActive
                ? "bg-[var(--color-surface)] text-[var(--color-fg)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)]"
            } bg-transparent`}
          >
            <PluginIcon name={item.icon} className="size-5" />
          </button>
        );
      })}
    </div>
  );
}

export function RightPanelContent(): React.ReactNode {
  useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SidePanelItem[]>([]);
  const activeTabs = useUiStore((s) => s.activeSidePanelTabs);
  const [handleDragging, setHandleDragging] = useState(false);

  useEffect(() => {
    void window.pi.slots.sidePanel().then(setItems);
  }, []);

  const activeItems = items.filter((item) => activeTabs.includes(item.id));

  if (activeItems.length === 0) {
    return <div className="h-full bg-[var(--color-chrome)]" />;
  }

  return (
    <div className="h-full flex flex-col bg-[var(--color-chrome)]">
      <PanelGroup direction="vertical" className="h-full" autoSaveId="right-panel-v">
        {activeItems.map((item, i) => {
          const Comp = getSidePanelComponent(item.component);
          return (
            <Fragment key={item.id}>
              <Panel minSize={10} className="min-h-0">
                <div className="h-full flex flex-col min-h-0">
                  <div
                    className="flex items-center gap-1.5 px-2.5 py-1.5 shrink-0 border-b border-[var(--color-border)] text-[var(--font-size-sm)] text-[var(--color-muted)] select-none cursor-pointer"
                    onClick={() => useUiStore.getState().toggleSidePanelTab(item.id)}
                  >
                    <PluginIcon name={item.icon} className="size-3.5" />
                    <span>{item.label}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto min-h-0">
                    {Comp ? <Comp /> : (
                      <div className="p-4 text-[var(--color-muted)] text-[var(--font-size-sm)]">
                        组件未注册: {item.component}（插件 {item.pluginId}）
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
              {i < activeItems.length - 1 && (
                <PanelResizeHandle
                  onDragging={setHandleDragging}
                  style={{
                    height: "8px",
                    cursor: "row-resize",
                    background: "transparent",
                    display: "flex",
                    alignItems: "center",
                    transition: "background 0.15s",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: "var(--divider-width)",
                      margin: "0 var(--divider-inset)",
                      background: handleDragging ? "var(--color-primary)" : "var(--divider-color)",
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
