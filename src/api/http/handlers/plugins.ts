// IPC:插件生命周期管理(plugins.*)—— 注册/启停/卸载/安装/加载失败上报。
import {} from "electron";
import type { Gateway } from "../../../core/application/remote/gateway";
import { discoverPlugins } from "../../../core/application/loader/discover";
import {
  activate, disablePlugin, enablePlugin, uninstallPlugin, reloadPlugin,
  getPluginState, reportLoadFailure, erroredPlugins,
  type PluginLifecycleDeps,
} from "../../../core/application/lifecycle";
import { install as installPlugin, UrlSource, LocalFileSource } from "../../../core/application/installer";
import type { PluginListItem, PluginManifest } from "../../../core/domain/contributions";
import { resolvePluginTags } from "../../../core/domain/contributions";
import { IPC } from "../../../core/domain/channel-contract";
import { notifyPluginsChanged, notifyPluginUnloaded } from "../../ipc/broadcast";
import type { MainContext } from "../../ipc/main-context";

export function registerPlugins(gateway: Gateway, ctx: MainContext): void {
  const { registry, configStore, paths, pluginSkillsEnsure, pluginPiExtensionEnsure, pluginDshExtensionEnsure } = ctx;

  // 评估 P1-A2:此前 main 侧 pluginLoader 按 source 分轨——builtin 走 import.meta.glob
  // (编译期),第三方走 file:// 动态 import。但 main 进程不渲染插件 UI(React 组件在 renderer
  // 进程),main 侧 load renderer chunk 是死代码(且 main 是 CJS,import React ESM chunk 会失败)。
  // 真正的插件 renderer 加载在 renderer 侧 plugins-host(经 import.meta.glob 统一加载内置,
  // 无 if-builtin 分支)。main 侧 loader 改 no-op:只管注册/通知,不碰 renderer chunk。
  // 这消除 main 侧的 if(source==="builtin") 双轨分支(违反 §1.4 无特权差异)。
  const pluginLoader = {
    async load(_manifest: PluginManifest, _pluginPath: string): Promise<void> {
      // no-op:renderer 侧 plugins-host 负责加载插件 renderer。main 只管注册 + notifyPluginsChanged。
    },
    unload(_pluginId: string): void {},
  };

  const lifecycleDeps: PluginLifecycleDeps = {
    registry,
    configStore,
    loader: pluginLoader,
    notifyPluginsChanged,
    notifyPluginUnloaded,
    skillsEnsure: pluginSkillsEnsure,
    piExtensionEnsure: pluginPiExtensionEnsure,
    dshExtensionEnsure: pluginDshExtensionEnsure,
  };

  function rediscoverPlugin(pluginId: string): { manifest: PluginManifest; path: string; source: "builtin" | "user" | "installed" | "project" } | undefined {
    // 与启动发现同一条递归下降(按 manifest.id 匹配)。根因:旧码 join(dir, pluginId)
    // 平铺直查,而内置仓库按域分组(sessions/markdown 等多一层)——内置件卸载后
    // 装不回(enable/reload 永远 notFound)。复用 discoverPlugins 单源逻辑。
    const dirs: [string, "builtin" | "user" | "installed" | "project"][] = [
      [paths.projectPluginsDir, "project"],
      [paths.userPluginsDir, "user"],
      [paths.installedDir, "installed"],
      [paths.builtinDir, "builtin"],
    ];
    for (const [dir, src] of dirs) {
      const found = discoverPlugins(dir, src).find((d) => d.manifest.id === pluginId);
      if (found) return { manifest: found.manifest, path: found.path, source: src };
    }
    return undefined;
  }

  function inferTier(manifest: PluginManifest, _source: string): "official" | "verified" | "community" {
    // 无特权差异(§1.4):tier 由 manifest 声明,不按 source 自动赋级(避免"内置=official"特权)。
    // 未声明 tier 的插件统一 community(中性兜底),需特权的插件在 plugin.json 声明 "tier"。
    return manifest.tier ?? "community";
  }

  gateway.register(IPC.plugins.list, async () => {
    const disabled = (await configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
    const list: PluginListItem[] = [];
    for (const [id, plugin] of registry.allPlugins()) {
      const isBuiltin = plugin.source === "builtin";
      list.push({
        id,
        displayName: plugin.manifest.displayName ?? id,
        description: plugin.manifest.description,
        version: plugin.manifest.version,
        source: plugin.source,
        tier: inferTier(plugin.manifest, plugin.source),
        state: getPluginState(id, disabled),
        protected: !!plugin.manifest.protected,
        path: isBuiltin ? null : plugin.path,
        renderer: isBuiltin ? null : (plugin.manifest.renderer ?? "./renderer/index.js"),
        contributes: plugin.manifest.contributes,
        tags: resolvePluginTags(plugin.manifest),
      });
    }
    // disabled + error(renderer 上报加载失败被撤注册)：不在注册表里的也要列出供管理页展示，
    // state 由 getPluginState 判定(error 优先于 inactive)——加载失败是可见的一等状态，不再静默消失。
    for (const id of new Set([...disabled, ...erroredPlugins()])) {
      if (!registry.manifestOf(id)) {
        const discovered = rediscoverPlugin(id);
        if (discovered) {
          const isBuiltin = discovered.source === "builtin";
          list.push({
            id,
            displayName: discovered.manifest.displayName ?? id,
            description: discovered.manifest.description,
            version: discovered.manifest.version,
            source: discovered.source,
            tier: inferTier(discovered.manifest, discovered.source),
            state: getPluginState(id, disabled),
            protected: !!discovered.manifest.protected,
            path: isBuiltin ? null : discovered.path,
            renderer: isBuiltin ? null : (discovered.manifest.renderer ?? "./renderer/index.js"),
            contributes: discovered.manifest.contributes,
            tags: resolvePluginTags(discovered.manifest),
          });
        }
      }
    }
    return list;
  });

  gateway.register(IPC.plugins.enable, async (_e, pluginId: string) => {
    return enablePlugin(lifecycleDeps, pluginId, () => rediscoverPlugin(pluginId));
  });

  gateway.register(IPC.plugins.disable, async (_e, pluginId: string) => {
    return disablePlugin(lifecycleDeps, pluginId);
  });

  gateway.register(IPC.plugins.uninstall, async (_e, pluginId: string) => {
    return uninstallPlugin(lifecycleDeps, pluginId);
  });

  gateway.register(IPC.plugins.reload, async (_e, pluginId: string) => {
    return reloadPlugin(lifecycleDeps, pluginId, () => rediscoverPlugin(pluginId));
  });

  // renderer 上报插件 renderer 模块加载失败：撤注册 + 记 error + 广播（与 activate 失败分支同出口）。
  gateway.register(IPC.plugins.loadFailed, (_e, pluginId: string) => {
    reportLoadFailure(lifecycleDeps, pluginId);
  });

  gateway.register(IPC.plugins.install, async (_e, source: { type: "url" | "local"; location: string }) => {
    const installSource = source.type === "url"
      ? new UrlSource(source.location)
      : new LocalFileSource(source.location);
    const result = await installPlugin(installSource, paths.installedDir);
    if (!result.ok || !result.manifest || !result.pluginPath) return result;
    return activate(lifecycleDeps, result.manifest, result.pluginPath, "installed");
  });
}
