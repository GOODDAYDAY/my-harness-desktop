// 右面板壳 —— sidePanel 槽的渲染 chrome。
//
// 壳只认槽位契约:从 slots:sidePanel 读贡献项,Radix Tabs 渲染页签壳,
// 内容组件经 @pi-desktop/react 注册中心按 component 名查(插件自注册)。
// keep-alive(forceMount):事件流插件(token-stats)的订阅要常驻,切走不能卸载。
import { useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { PluginIcon, getSidePanelComponent, useUiStore } from "@pi-desktop/react";

interface SidePanelItem {
  id: string;
  label: string;
  icon: string;
  component: string;
  pluginId: string;
}

export function RightPanel(): React.ReactNode {
  // 订阅插件注册世代号:plugins-host 异步注册完成后重渲染,组件才查得到
  useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SidePanelItem[]>([]);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    void window.pi.slots.sidePanel().then((list) => {
      setItems(list);
      setActive((prev) => prev || (list.length > 0 ? list[0].id : ""));
    });
  }, []);

  if (items.length === 0) return null;

  return (
    <Tabs.Root
      value={active}
      onValueChange={setActive}
      className="flex flex-col h-full bg-[var(--color-bg)] border-l border-[var(--color-border)]"
    >
      <Tabs.List className="flex shrink-0 border-b border-[var(--color-border)] px-1">
        {items.map((item) => (
          <Tabs.Trigger
            key={item.id}
            value={item.id}
            className="flex items-center gap-1.5 px-2.5 py-2 text-[var(--font-size-sm)] cursor-pointer bg-transparent border-none font-[var(--font-family-sans)] data-[state=active]:text-[var(--color-fg)] data-[state=inactive]:text-[var(--color-muted)] data-[state=active]:border-b-2 data-[state=active]:border-[var(--color-primary)] hover:text-[var(--color-fg)]"
            style={{ borderBottom: active === item.id ? "2px solid var(--color-primary)" : "2px solid transparent" }}
          >
            <PluginIcon name={item.icon} className="size-3.5" />
            {item.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {items.map((item) => {
        const Comp = getSidePanelComponent(item.component);
        return (
          <Tabs.Content key={item.id} value={item.id} forceMount className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
            {Comp ? <Comp /> : (
              <div className="p-4 text-[var(--color-muted)] text-[var(--font-size-sm)]">
                组件未注册: {item.component}(插件 {item.pluginId})
              </div>
            )}
          </Tabs.Content>
        );
      })}
    </Tabs.Root>
  );
}
