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
import { useUiStore, getSidebarComponent } from "@pi-desktop/react";
import { ChatRow } from "../ui/chat-row";

interface SidebarItem {
  id: string;
  title: string;
  component: string;
  pluginId: string;
}

export function Sidebar(): React.ReactNode {
  const { t } = useTranslation();
  const setMainView = useUiStore((s) => s.setMainView);
  // 订阅插件注册世代号:plugins-host 异步注册完成后重渲染,组件才查得到
  useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SidebarItem[]>([]);
  // 任一分割线拖拽中 → 显 primary 色(松手回透明),复用 index.tsx 的 onDragging 模式
  const [handleDragging, setHandleDragging] = useState(false);

  useEffect(() => {
    void window.pi.slots.sidebar().then(setItems);
  }, []);

  // 两组分栏默认比:项目栏小(28)、对话栏大(72,主力);其余数量交给库自动均分
  const defaultSize = (i: number): number | undefined => (items.length === 2 ? (i === 0 ? 28 : 72) : undefined);

  return (
    <div
      className="flex flex-col h-full w-full border-r border-[var(--color-border)]"
      // 侧栏比主区压深一层(ChatGPT #171717 vs #212121);color-mix 从主题 bg 派生,不写死色值
      style={{ background: "color-mix(in srgb, var(--color-bg) 70%, black)" }}
    >
      {/* 分组区:sidebar 槽贡献项按 order 渲染,每组一个插件组件,各自管折叠/数据。
          纵向 PanelGroup:每个 Panel 内独立 overflow-y-auto → 分组各自滚动;
          相邻 Panel 间 PanelResizeHandle 可拖拽改高度比。 */}
      <div className="flex-1 min-h-0">
        <PanelGroup direction="vertical" className="h-full" autoSaveId="sidebar-v">
          {items.map((item, i) => {
            const Comp = getSidebarComponent(item.component);
            return (
              <Fragment key={item.id}>
                <Panel
                  defaultSize={defaultSize(i)}
                  minSize={10}
                  className="min-h-0"
                >
                  {/* 每个 Panel 自己 overflow-y-auto:内容超长滚自己的,不撑爆也不串到别的分组 */}
                  <div className="h-full overflow-y-auto flex flex-col px-2.5 pt-3 pb-2">
                    {Comp ? (
                      <Comp />
                    ) : (
                      <div className="px-2 py-1 text-[var(--font-size-sm)] text-[var(--color-muted)]">
                        组件未注册: {item.component}(插件 {item.pluginId})
                      </div>
                    )}
                  </div>
                </Panel>
                {i < items.length - 1 && (
                  <PanelResizeHandle
                    onDragging={setHandleDragging}
                    style={{
                      height: "6px",
                      cursor: "row-resize",
                      // 常驻可见:从主题 border 派生并提亮一档(color-mix 掺白),不写死色值 → 随主题变;
                      // 拖拽中切 primary 高亮。比原来 transparent 看得见,又不像固定灰那么生硬。
                      background: handleDragging
                        ? "var(--color-primary)"
                        : "color-mix(in srgb, var(--color-border) 65%, white 25%)",
                      transition: "background 0.15s",
                    }}
                  />
                )}
              </Fragment>
            );
          })}
        </PanelGroup>
      </div>

      {/* 设置(壳的入口:设置框架是核心) */}
      <div className="border-t border-[var(--color-border)] shrink-0 px-2 py-2">
        <ChatRow onClick={() => setMainView("settings")} icon={<Settings className="size-4.5" />}>
          {t("shell.settings")}
        </ChatRow>
      </div>
    </div>
  );
}
