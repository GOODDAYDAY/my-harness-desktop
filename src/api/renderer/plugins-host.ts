import { useUiStore, eventBus, registerPluginComponents, unregisterPluginComponents, registerPluginMessageRenderers, unregisterPluginMessageRenderers, registerPluginModule, unregisterPluginModule, type PluginListItem } from "@pi-desktop/react";

const builtinModules = import.meta.glob("../../plugins/*/*/renderer/index.{ts,tsx}");
if (Object.keys(builtinModules).length === 0) {
  throw new Error(
    "[plugins-host] glob 匹配 0 个内置插件 renderer,路径可能写错(应在 src/plugins/<组>/<插件>/renderer/index.tsx)",
  );
}

const loadedThirdParty = new Set<string>();
const loadedBuiltin = new Set<string>();
// 加载已失败的内置插件:chunk 在构建期固化,运行期重试无意义;
// 且失败上报会触发 pluginsChanged 广播,不拦住会造成 失败→上报→广播→重试 死循环
const failedBuiltin = new Set<string>();
const builtinPathById = new Map<string, string>();
for (const path of Object.keys(builtinModules)) {
  // 插件 id = renderer 的直接上级目录(分组层[^/]+不计),须与 manifest.id 一致
  const match = path.match(/plugins\/(?:[^/]+\/)*([^/]+)\/renderer/);
  if (match) builtinPathById.set(match[1], path);
}

const pluginManifests = new Map<string, PluginListItem>();

async function loadBuiltin(pluginId: string, manifest: PluginListItem): Promise<void> {
  const path = builtinPathById.get(pluginId);
  if (!path) throw new Error(`builtin 插件 ${pluginId} 的 renderer chunk 未找到`);
  const mod = await builtinModules[path]() as Record<string, unknown>;
  registerPluginComponents(mod, manifest.contributes ?? {});
  registerPluginMessageRenderers(mod, manifest.contributes ?? {});
  const channels = mod.channels;
  if (Array.isArray(channels)) {
    eventBus.registerChannels(pluginId, channels as string[]);
  }
  pluginManifests.set(pluginId, manifest);
  registerPluginModule(pluginId, mod);
  loadedBuiltin.add(pluginId);
}

async function loadThirdParty(pluginId: string, pluginPath: string, rendererEntry: string, manifest: PluginListItem): Promise<void> {
  const fullPath = `${pluginPath}/${rendererEntry}`.replace(/\\/g, "/");
  const mod = await import(/* @vite-ignore */ `file://${fullPath}?t=${Date.now()}`) as Record<string, unknown>;
  registerPluginComponents(mod, manifest.contributes ?? {});
  registerPluginMessageRenderers(mod, manifest.contributes ?? {});
  const channels = mod.channels;
  if (Array.isArray(channels)) {
    eventBus.registerChannels(pluginId, channels as string[]);
  }
  pluginManifests.set(pluginId, manifest);
  registerPluginModule(pluginId, mod);
  loadedThirdParty.add(pluginId);
}

export let pluginsReady: Promise<void>;

async function bootstrap(): Promise<void> {
  const disabled = (await window.pi.config.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  const list = await window.pi.plugins.list() as PluginListItem[];
  const builtinIds = [...builtinPathById.keys()].filter((id) => !disabled.includes(id) && !failedBuiltin.has(id));
  const thirdParty = list.filter((p) => p.path && p.renderer && !disabled.includes(p.id) && p.state !== "error");

  const promises: Promise<void>[] = [];
  for (const id of builtinIds) {
    const manifest = list.find((p) => p.id === id);
    if (!manifest) continue;
    promises.push(loadBuiltin(id, manifest).catch((e) => {
      console.error(`[plugins-host] 内置插件加载失败: ${id}`, e);
      failedBuiltin.add(id);
      void window.pi.plugins.reportLoadFailed(id);
    }));
  }
  for (const p of thirdParty) {
    promises.push(loadThirdParty(p.id, p.path!, p.renderer!, p).catch((e) => {
      console.error(`[plugins-host] 第三方插件加载失败: ${p.id}`, e);
      void window.pi.plugins.reportLoadFailed(p.id);
    }));
  }
  await Promise.all(promises);
  useUiStore.getState().bumpPlugins();
}

pluginsReady = bootstrap().catch((e) => {
  console.error("[plugins-host] 插件加载流程失败", e);
  useUiStore.getState().bumpPlugins();
});

window.pi.plugins.onUnloaded((pluginId: string, _components: string[]) => {
  loadedBuiltin.delete(pluginId);
  loadedThirdParty.delete(pluginId);
  eventBus.unregisterPlugin(pluginId);
  unregisterPluginModule(pluginId);
  const manifest = pluginManifests.get(pluginId);
  if (manifest) {
    unregisterPluginComponents(manifest.contributes ?? {});
    unregisterPluginMessageRenderers(manifest.contributes ?? {});
    pluginManifests.delete(pluginId);
  }
});

window.pi.plugins.onPluginsChanged(async () => {
  // main 的 nonce 只作触发信号,不取它的值:main/renderer 是两个独立计数器,
  // 直接覆盖可能撞同值——zustand selector 同值不通知,依赖 pluginsNonce 的
  // 槽清单重拉被静默吞掉,而 onUnloaded 已清组件注册表,右栏出现"组件未注册"
  // 孤儿 Tab(首次插件生命周期操作必现:两端分别从 0/1 起步)。本地自增无撞车窗口。
  useUiStore.getState().bumpPlugins();
  const disabled = (await window.pi.config.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  const list = await window.pi.plugins.list() as PluginListItem[];
  const loads: Promise<void>[] = [];
  for (const id of builtinPathById.keys()) {
    // failedBuiltin 防死循环:加载失败已上报触发本事件,重试同一个静态打包的 chunk 必然再失败
    if (!disabled.includes(id) && !loadedBuiltin.has(id) && !failedBuiltin.has(id)) {
      const manifest = list.find((p) => p.id === id);
      if (manifest) {
        loads.push(loadBuiltin(id, manifest).catch((e) => console.error(`[plugins-host] 热加载内置插件失败: ${id}`, e)));
      }
    }
  }
  // state!==error 防死循环:加载失败已上报→主进程记 error 态→仍随列表返回,
  // 不过滤会在每次 pluginsChanged 事件里无限重试
  const toLoad = list.filter((p) => p.path && p.renderer && p.state !== "error" && !disabled.includes(p.id) && !loadedThirdParty.has(p.id));
  for (const p of toLoad) {
    loads.push(loadThirdParty(p.id, p.path!, p.renderer!, p).catch((e) => {
      console.error(`[plugins-host] 热加载第三方插件失败: ${p.id}`, e);
      void window.pi.plugins.reportLoadFailed(p.id);
    }));
  }
  // 热加载完成后二次 bump:首 bump 时槽清单已含新插件但模块未注册,组件解析类消费方
  // (blockRenderers/codeBlockRenderers 经 getPluginComponent 同步解析)会解析落空;
  // 模块注册完再不 bump,解析结果就永久停在兜底态(卸载降级即时、装回不生效)。
  await Promise.all(loads);
  useUiStore.getState().bumpPlugins();
});

window.pi.onSettingsChanged(() => {
  eventBus.emitSystem("system:settingsChanged", {});
});

window.pi.themes.onSystemChanged(() => {
  eventBus.emitSystem("system:systemThemeChanged", {});
});
