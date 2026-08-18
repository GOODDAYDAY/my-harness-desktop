import { Copy, Minus, PanelLeft, PanelRight, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { getTitlebarComponent, useUiStore, PluginIdContext, useLayoutStore, useGroupHidden, DEFAULT_GROUP_IDS, eventBus } from "@my-harness-desktop/react";

const iconBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "28px", height: "28px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
  // @ts-expect-error 拖拽区是 Electron 私有 CSS 属性
  WebkitAppRegion: "no-drag",
};

interface TitlebarItem {
  id: string;
  component: string;
  pluginId: string;
}

// mac 红绿灯原生;win/linux 无边框窗口的 min/max/close 由这里自绘(经 window.pi.window IPC)。
const isMac = window.pi.platform === "darwin";

export function Titlebar(): React.ReactNode {
  const { t } = useTranslation();
  const sessionTitle = useUiStore((s) => s.sessionTitle);
  const activeView = useUiStore((s) => s.activeView);
  const leftPanelHidden = useGroupHidden(DEFAULT_GROUP_IDS.LEFT);
  const rightPanelHidden = useGroupHidden(DEFAULT_GROUP_IDS.RIGHT);
  const setGroupHidden = useLayoutStore((s) => s.setGroupHidden);
  const [items, setItems] = useState<TitlebarItem[]>([]);
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.pi.slots.titlebar().then(setItems);
  }, [pluginsNonce]);

  useEffect(() => {
    if (isMac) return;
    void window.pi.window.isMaximized().then(setMaximized);
    return window.pi.window.onMaximizedChanged(setMaximized);
  }, []);

  return (
    <div
      className="relative flex items-center h-10 shrink-0 select-none"
      style={{
        // @ts-expect-error Electron 私有属性:整条标题栏可拖拽移动窗口
        WebkitAppRegion: "drag",
        paddingLeft: isMac ? "88px" : "var(--spacing-sm)", // mac 给红绿灯让位(trafficLightPosition x:14)
        paddingRight: isMac ? "var(--spacing-sm)" : 0,
        borderBottom: "1px solid var(--color-border)",
      }}
      onDoubleClick={isMac ? undefined : () => void window.pi.window.toggleMaximize()}
    >
      <button style={iconBtn} title={t("shell.toggleLeft")} onClick={() => setGroupHidden(DEFAULT_GROUP_IDS.LEFT, !leftPanelHidden)}>
        <PanelLeft className="size-4" style={{ opacity: leftPanelHidden ? 0.5 : 1 }} />
      </button>

      <div
        className="flex items-center gap-1.5 ml-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]"
        style={activeView === "settings" ? {
          cursor: "pointer",
          // @ts-expect-error 拖拽区是 Electron 私有 CSS 属性
          WebkitAppRegion: "no-drag",
        } : undefined}
        onClick={activeView === "settings" ? () => eventBus.emitSystem("system:requestNavigateToChat") : undefined}
      >
        <span style={{ fontFamily: "var(--font-family-sans)" }}>π</span>
        <span>Desktop</span>
        <span style={{ opacity: 0.5 }}>/</span>
        <span className="text-[var(--color-fg)]">{sessionTitle ?? t("shell.newChat")}</span>
      </div>

      <div className="ml-auto flex items-center gap-1 self-stretch">
        {items.map((item) => {
          const Comp = getTitlebarComponent(item.component);
          if (!Comp) return null;
          return (
            <PluginIdContext.Provider key={item.id} value={item.pluginId}>
              <Comp />
            </PluginIdContext.Provider>
          );
        })}
        <button style={iconBtn} title={t("shell.toggleRight")} onClick={() => setGroupHidden(DEFAULT_GROUP_IDS.RIGHT, !rightPanelHidden)}>
          <PanelRight className="size-4" style={{ opacity: rightPanelHidden ? 0.5 : 1 }} />
        </button>
        {!isMac && (
          <div
            className="flex items-stretch ml-1"
            // @ts-expect-error 拖拽区是 Electron 私有 CSS 属性
            style={{ WebkitAppRegion: "no-drag" }}
          >
            <button
              className="flex items-center justify-center w-11 border-none bg-transparent text-[var(--color-muted)] cursor-pointer hover:bg-[var(--color-surface)]"
              onClick={() => void window.pi.window.minimize()}
            >
              <Minus className="size-4" />
            </button>
            <button
              className="flex items-center justify-center w-11 border-none bg-transparent text-[var(--color-muted)] cursor-pointer hover:bg-[var(--color-surface)]"
              onClick={() => void window.pi.window.toggleMaximize()}
            >
              {maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
            </button>
            <button
              className="flex items-center justify-center w-11 border-none bg-transparent text-[var(--color-muted)] cursor-pointer hover:bg-[var(--color-accent-danger)] hover:text-[var(--color-fg)]"
              onClick={() => void window.pi.window.close()}
            >
              <X className="size-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
