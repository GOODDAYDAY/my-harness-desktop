import { useMemo } from "react";
import { ErrorBoundary } from "./error-boundary";
import { PluginIdContext } from "./plugin-id-context";
import { getLoadedPluginIds, getPluginOverlay, asReactComponent } from "./plugin-modules";
import { useUiStore } from "../../../src/api/renderer/stores/ui-store";

export function PluginOverlays(): React.ReactNode {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const overlays = useMemo(() => {
    const ids = getLoadedPluginIds();
    const result: { pluginId: string; Component: React.ComponentType }[] = [];
    for (const id of ids) {
      const overlay = asReactComponent(getPluginOverlay(id));
      if (overlay) {
        result.push({ pluginId: id, Component: overlay as React.ComponentType });
      }
    }
    return result;
  }, [pluginsNonce]);

  // 每个 overlay 独立边界:单个插件的悬浮层崩溃只摘除自己,不拖垮主树(共享根级边界)。
  return overlays.map(({ pluginId, Component }) => (
    <PluginIdContext.Provider key={pluginId} value={pluginId}>
      <ErrorBoundary fallback={null} onError={(err) => console.error(`[overlay:${pluginId}]`, err)}>
        <Component />
      </ErrorBoundary>
    </PluginIdContext.Provider>
  ));
}
