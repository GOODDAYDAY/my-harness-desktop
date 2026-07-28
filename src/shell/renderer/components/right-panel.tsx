import { useEffect, useState } from "react";
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
  const active = useUiStore((s) => s.activeSidePanelTab);
  const setActiveSidePanelTab = useUiStore((s) => s.setActiveSidePanelTab);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);

  useEffect(() => {
    void window.pi.slots.sidePanel().then(setItems);
  }, []);

  const handleClick = (item: SidePanelItem): void => {
    if (active === item.id) {
      setRightPanelOpen(!rightPanelOpen);
    } else {
      setActiveSidePanelTab(item.id);
      setRightPanelOpen(true);
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-1 py-2 w-12 shrink-0 bg-[var(--color-chrome)] border-l border-[var(--color-border)]">
      {items.map((item) => {
        const isActive = active === item.id;
        const isHighlighted = isActive && rightPanelOpen;
        return (
          <button
            key={item.id}
            onClick={() => handleClick(item)}
            title={item.label}
            className={`flex items-center justify-center w-9 h-9 rounded-[var(--radius-sm)] cursor-pointer border-none transition-colors ${
              isHighlighted
                ? "bg-[var(--color-surface)] text-[var(--color-fg)]"
                : isActive
                  ? "text-[var(--color-fg)]"
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
  const active = useUiStore((s) => s.activeSidePanelTab);

  useEffect(() => {
    void window.pi.slots.sidePanel().then(setItems);
  }, []);

  if (items.length === 0 || !active) {
    return <div className="flex-1 bg-[var(--color-chrome)]" />;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[var(--color-chrome)]">
      {items.map((item) => {
        const Comp = getSidePanelComponent(item.component);
        const visible = active === item.id;
        return (
          <div key={item.id} className={visible ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
            {Comp ? <Comp /> : (
              <div className="p-4 text-[var(--color-muted)] text-[var(--font-size-sm)]">
                组件未注册: {item.component}(插件 {item.pluginId})
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
