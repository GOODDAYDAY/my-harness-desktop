import { useMemo } from "react";
import { PluginIdContext } from "./plugin-id-context";
import { getLoadedPluginIds, getPluginOverlay } from "./plugin-modules";
import { useUiStore } from "../../../src/api/renderer/stores/ui-store";

export function PluginOverlays(): React.ReactNode {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const overlays = useMemo(() => {
    const ids = getLoadedPluginIds();
    const result: { pluginId: string; Component: React.ComponentType }[] = [];
    for (const id of ids) {
      const overlay = getPluginOverlay(id);
      if (typeof overlay === "function") {
        result.push({ pluginId: id, Component: overlay as React.ComponentType });
      }
    }
    return result;
  }, [pluginsNonce]);

  return overlays.map(({ pluginId, Component }) => (
    <PluginIdContext.Provider key={pluginId} value={pluginId}>
      <Component />
    </PluginIdContext.Provider>
  ));
}
