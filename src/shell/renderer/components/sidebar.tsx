// 左栏壳 —— sidebar 槽的渲染 chrome + 底部"设置"入口。
//
// 壳只认槽位契约:从 slots:sidebar 读贡献项(按 order 排好序来),
// 分组组件经 @pi-desktop/react 注册中心按 component 名查(插件自注册)。
// 对话/项目分组都是插件(sidebar 槽);设置入口是壳的(设置框架是核心)。
import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { useUiStore, getSidebarComponent } from "@pi-desktop/react";
import { ChatRow } from "../ui/chat-row";

interface SidebarItem {
  id: string;
  title: string;
  component: string;
  pluginId: string;
}

export function Sidebar(): React.ReactNode {
  const setMainView = useUiStore((s) => s.setMainView);
  // 订阅插件注册世代号:plugins-host 异步注册完成后重渲染,组件才查得到
  useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SidebarItem[]>([]);

  useEffect(() => {
    void window.pi.slots.sidebar().then(setItems);
  }, []);

  return (
    <div
      className="flex flex-col h-full w-full border-r border-[var(--color-border)]"
      // 侧栏比主区压深一层(ChatGPT #171717 vs #212121);color-mix 从主题 bg 派生,不写死色值
      style={{ background: "color-mix(in srgb, var(--color-bg) 70%, black)" }}
    >
      {/* 分组区:sidebar 槽贡献项按 order 渲染,每组一个插件组件,各自管折叠/数据 */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5 px-2.5 pt-3.5 pb-2">
        {items.map((item) => {
          const Comp = getSidebarComponent(item.component);
          if (!Comp) {
            return (
              <div key={item.id} className="px-2 py-1 text-[var(--font-size-sm)] text-[var(--color-muted)]">
                组件未注册: {item.component}(插件 {item.pluginId})
              </div>
            );
          }
          return <Comp key={item.id} />;
        })}
      </div>

      {/* 设置(壳的入口:设置框架是核心) */}
      <div className="border-t border-[var(--color-border)] shrink-0 px-2 py-2">
        <ChatRow onClick={() => setMainView("settings")} icon={<Settings className="size-4.5" />}>
          设置
        </ChatRow>
      </div>
    </div>
  );
}
