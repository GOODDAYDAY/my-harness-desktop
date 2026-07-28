import { useUiStore, unregisterSettingsComponent, unregisterSidePanelComponent, unregisterSidebarComponent } from "@pi-desktop/react";
import { ipcRenderer } from "electron";

const modules = import.meta.glob("../../plugins/*/renderer/index.{ts,tsx}");
if (Object.keys(modules).length === 0) {
  throw new Error(
    "[plugins-host] glob 匹配 0 个内置插件 renderer,路径可能写错(应在 src/plugins/*/renderer/index.tsx)",
  );
}

void (async () => {
  const disabled = (await window.pi.config.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  const shouldSkip = (path: string): boolean => {
    const match = path.match(/plugins\/([^/]+)\/renderer/);
    return match ? disabled.includes(match[1]) : false;
  };
  const toLoad = Object.keys(modules).filter((p) => !shouldSkip(p));
  let loaded = 0;
  const total = toLoad.length;
  if (total === 0) {
    useUiStore.getState().bumpPlugins();
    return;
  }
  for (const path of toLoad) {
    void modules[path]().then(() => {
      loaded++;
      if (loaded === total) {
        useUiStore.getState().bumpPlugins();
      }
    });
  }
})();

ipcRenderer.on("plugin:unloaded", (_e, { components }: { components: string[] }) => {
  for (const name of components) {
    unregisterSettingsComponent(name);
    unregisterSidePanelComponent(name);
    unregisterSidebarComponent(name);
  }
});
