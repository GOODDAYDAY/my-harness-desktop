import { useUiStore, unregisterSettingsComponent, unregisterSidePanelComponent, unregisterSidebarComponent } from "@pi-desktop/react";

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
    const id = match?.[1];
    return id ? disabled.includes(id) : false;
  };
  const toLoad = Object.keys(modules).filter((p) => !shouldSkip(p));
  let loaded = 0;
  const total = toLoad.length;
  const onDone = (): void => {
    loaded++;
    if (loaded === total) {
      useUiStore.getState().bumpPlugins();
    }
  };
  if (total === 0) {
    useUiStore.getState().bumpPlugins();
    return;
  }
  for (const path of toLoad) {
    void modules[path]().then(onDone).catch((e) => {
      console.error(`[plugins-host] 插件加载失败: ${path}`, e);
      onDone();
    });
  }
})().catch((e) => {
  console.error("[plugins-host] 内置插件加载流程失败", e);
  useUiStore.getState().bumpPlugins();
});

window.pi.plugins.onUnloaded((components: string[]) => {
  for (const name of components) {
    unregisterSettingsComponent(name);
    unregisterSidePanelComponent(name);
    unregisterSidebarComponent(name);
  }
});

window.pi.plugins.onPluginsChanged((nonce: number) => {
  useUiStore.setState({ pluginsNonce: nonce });
});
