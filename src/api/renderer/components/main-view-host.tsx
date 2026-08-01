// 中区主视图宿主 —— 壳的机制组件:读 mainView 槽贡献 + 按名查组件渲染。
//
// 评估 P1-C:此前中区直接 <MessageList/>(时间线渲染焊在 shell,内容焊死内核,违反 §7.2)。
// 外推:壳只留空中区容器 + 按槽查组件,时间线内容由 timeline 插件贡献 mainView 槽渲染。
// 壳不认识 timeline,不 import 任何具体主视图组件——无特权差异(§1.4),第三方可写另一个
// mainView 插件覆盖内置 timeline(按 order 选第一个)。
import { useEffect, useState } from "react";
import { getMainViewComponent, useUiStore, PluginIdContext } from "@pi-desktop/react";
import { TimelineThemeScope } from "../theme-context";

interface MainViewItem {
  id: string;
  component: string;
  pluginId: string;
}

export function MainViewHost(): React.ReactNode {
  const [item, setItem] = useState<MainViewItem | null>(null);
  const [queried, setQueried] = useState(false);
  useUiStore((s) => s.pluginsNonce);

  useEffect(() => {
    void window.pi.slots.mainView().then((items) => {
      setItem(items[0] ?? null);
      setQueried(true);
    });
  }, []);

  // 查询未决时渲染空容器而非"无贡献"——避免 IPC 在途期间闪现误导性文案
  if (!queried) {
    return <div className="h-full" />;
  }
  if (!item) {
    return <div className="h-full flex items-center justify-center text-[var(--color-muted)] text-sm">mainView 槽无贡献</div>;
  }
  const Comp = getMainViewComponent(item.component);
  if (!Comp) {
    return <div className="h-full flex items-center justify-center text-[var(--color-muted)] text-sm">主视图组件 {item.component} 未注册</div>;
  }
  return (
    <PluginIdContext.Provider value={item.pluginId}>
      <TimelineThemeScope>
        <Comp />
      </TimelineThemeScope>
    </PluginIdContext.Provider>
  );
}
