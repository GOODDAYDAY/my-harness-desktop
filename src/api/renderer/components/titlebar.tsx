import { PanelLeft, PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { getTitlebarComponent, useUiStore, PluginIdContext, useLayoutStore, useGroupHidden, DEFAULT_GROUP_IDS } from "@pi-desktop/react";

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

export function Titlebar(): React.ReactNode {
  const { t } = useTranslation();
  const sessionTitle = useUiStore((s) => s.sessionTitle);
  const leftPanelHidden = useGroupHidden(DEFAULT_GROUP_IDS.LEFT);
  const rightPanelHidden = useGroupHidden(DEFAULT_GROUP_IDS.RIGHT);
  const setGroupHidden = useLayoutStore((s) => s.setGroupHidden);
  const [items, setItems] = useState<TitlebarItem[]>([]);
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);

  useEffect(() => {
    void window.pi.slots.titlebar().then(setItems);
  }, [pluginsNonce]);

  return (
    <div
      className="relative flex items-center h-10 shrink-0 select-none"
      style={{
        // @ts-expect-error Electron 私有属性:整条标题栏可拖拽移动窗口
        WebkitAppRegion: "drag",
        paddingLeft: "88px", // 给红绿灯让位(trafficLightPosition x:14)
        paddingRight: "var(--spacing-sm)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <button style={iconBtn} title={t("shell.toggleLeft")} onClick={() => setGroupHidden(DEFAULT_GROUP_IDS.LEFT, !leftPanelHidden)}>
        <PanelLeft className="size-4" style={{ opacity: leftPanelHidden ? 0.5 : 1 }} />
      </button>

      <div className="flex items-center gap-1.5 ml-2 text-[14px] text-[var(--color-muted)]">
        <span style={{ fontFamily: "var(--font-family-sans)" }}>π</span>
        <span>Desktop</span>
        <span style={{ opacity: 0.5 }}>/</span>
        <span className="text-[var(--color-fg)]">{sessionTitle ?? t("shell.newChat")}</span>
      </div>

      <div className="ml-auto flex items-center gap-1">
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
      </div>
    </div>
  );
}
